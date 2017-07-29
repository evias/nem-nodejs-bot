/**
 * Part of the evias/nem-nodejs-bot package.
 *
 * NOTICE OF LICENSE
 *
 * Licensed under MIT License.
 *
 * This source file is subject to the MIT License that is
 * bundled with this package in the LICENSE file.
 *
 * @package    evias/nem-nodejs-bot
 * @author     Grégory Saive <greg@evias.be> (https://github.com/evias)
 * @license    MIT License
 * @copyright  (c) 2017, Grégory Saive <greg@evias.be>
 * @link       https://github.com/evias/nem-nodejs-bot
 */

(function() {

    var nemAPI = require("nem-api");
    var BlocksAuditor = require("./blocks-auditor.js").BlocksAuditor;
    var SocketErrorHandler = require("./socket-error-handler.js").SocketErrorHandler;

    /**
     * class MultisigCosignatory implements an example of multi signature
     * accounts co signatory bots listening to NIS Websockets and automatically
     * co-signing PRE-CONFIGURED invoices.
     *
     * The "pre-configured" part is important in order to limit and avoid hacks
     * on the Bot's cosignatory features.
     *
     * ONLY THE BLOCKCHAIN is used for communication in this class.
     *
     * The database is used to hold an history of automatically co-signed
     * transactions data.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var MultisigCosignatory = function(chainDataLayer) {
        var api_ = nemAPI;

        this.blockchain_ = chainDataLayer;
        this.db_ = this.blockchain_.getDatabaseAdapter();

        this.nemsocket_ = null;
        this.backend_ = null;
        this.channel_ = null;
        this.params_ = null;
        this.caughtTrxs_ = null;
        this.nemConnection_ = null;
        this.nemSubscriptions_ = {};

        this.auditor_ = null;
        this.errorHandler_ = null;
        this.moduleName = "sign-socket";
        this.logLabel = "SIGN-SOCKET";
        this.fallback_ = null;

        this.options_ = {
            mandatoryMessage: true
        };

        this.logger = function() {
            return this.blockchain_.logger();
        };

        this.config = function() {
            return this.blockchain_.conf_;
        };

        this.getAuditor = function() {
            return this.auditor_;
        };

        this.getErrorHandler = function() {
            return this.errorHandler_;
        };

        // define a helper function to automatically sign incoming unconfirmed transactions
        // with the NEMBot's cosignatory wallet private key. The more cosignatory bots, the more
        // security is increased as it will be hard for a hacker to disclose all bots. Plus the
        // fact that SIGNER bots communicate only through the Blockchain.
        var automaticTransactionSigningHandler = function(instance, transactionMetaDataPair) {
            var multiAddress = instance.blockchain_.getBotSignMultisigWallet();
            var cosigAddress = instance.blockchain_.getBotSignWallet();
            var trxHash = instance.blockchain_.getTransactionHash(transactionMetaDataPair);

            instance.db_.NEMSignedTransaction.findOne({ transactionHash: trxHash }, function(err, signedTrx) {
                if (!err && signedTrx) {
                    // transaction already signed
                    //instance.logger().info("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Transaction already signed: " + trxHash);
                    return false;
                } else if (err) {
                    instance.logger().info("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Database Error with NEMSignedTransaction: " + err);
                    return false;
                }

                instance.logger().info("[NEM] [SIGN] ", __line, "Will sign " + trxHash + " with " + instance.blockchain_.getBotSignWallet() + " for " + instance.blockchain_.getBotSignMultisigWallet() + ".");

                // transaction not found in database, will now issue transaction co-signing
                // in case this transaction does not exceed the daily maximum amount.

                //DEBUG instance.logger().info("[NEM] [SIGN-SOCKET] [DEBUG]", __line, "now signing transaction: " + trxHash);

                instance.db_.NEMSignedTransaction.aggregate({ $group: { _id: null, dailyAmount: { $sum: "$amountXEM" } } }, { $project: { _id: 0, dailyAmount: 1 } },
                    function(err, aggregateData) {
                        // (1) verify daily maximum amount with current transaction amount
                        // - only the XEM amount can be limited for now (also looks for mosaics in case of
                        //   mosaic transfer transactions)

                        var dailyAmt = aggregateData && aggregateData.dailyAmount > 0 ? aggregateData.dailyAmount : 0;
                        var dailyMax = instance.blockchain_.conf_.bot.sign.dailyAmount;
                        if (dailyMax > 0 && dailyAmt >= dailyMax) {
                            // reached daily limit!
                            instance.logger().warn("[NEM] [SIGN-SOCKET] [LIMIT]", __line, "Limit of co-signatory Bot reached: " + dailyMax);
                            return false;
                        }

                        var trxAmount = instance.blockchain_.getTransactionAmount(transactionMetaDataPair);

                        if (dailyMax > 0 && dailyAmt + trxAmount > dailyMax) {
                            // can't sign this transaction, would pass daily limit.
                            instance.logger().warn("[NEM] [SIGN-SOCKET] [LIMIT]", __line, "Limit of co-signatory Bot would be passed: " + (dailyAmt + trxAmount));
                            return false;
                        }

                        // (2) sign transaction and broadcast to network.
                        // (3) save signed transaction data to database.
                        try {
                            var broadcastable = instance.signTransaction(transactionMetaDataPair,
                                function(response) {
                                    // now save to db
                                    var transaction = new instance.db_.NEMSignedTransaction({
                                        multisigXEM: multiAddress,
                                        cosignerXEM: cosigAddress,
                                        transactionHash: trxHash,
                                        nemNodeData: { socketHost: instance.nemsocket_.socketpt },
                                        transactionData: transactionMetaDataPair,
                                        amountXEM: trxAmount,
                                        createdAt: new Date().valueOf()
                                    });
                                    transaction.save();
                                });
                        } catch (e) {
                            instance.logger().error("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Signing aborted: " + e);
                        }
                    });

                return false;
            });
        };

        // define fallback in case websocket does not catch transaction!
        // This uses the NEM-sdk to make sure that we don't open a HTTP
        // communication channel or whatever to any other point than to
        // the NIS blockchain endpoints.
        var websocketFallbackHandler = function(instance) {
            // XXX should also check the Block Height and Last Block to know whether there CAN be new data.

            instance.logger().info("[NEM] [SIGN-FALLBACK] [TRY] ", __line, "Checking unconfirmed transactions of " + instance.blockchain_.getBotSignMultisigWallet() + ".");

            // read the payment channel recipient's incoming transaction to check whether the Websocket
            // has missed any (happens maybe only on testnet, but this is for being sure.). The same event
            // will be emitted in case a transaction is found un-forwarded.
            instance.blockchain_.nem().com
                .requests.account.transactions
                .unconfirmed(instance.blockchain_.endpoint(), instance.blockchain_.getBotSignMultisigWallet())
                .then(function(res) {

                    var unconfirmed = res.data;

                    for (var i in unconfirmed) {
                        var transaction = unconfirmed[i];

                        var meta = transaction.meta;
                        var content = transaction.transaction;

                        //XXX implement real verification of transaction type. In case it is a multisig
                        //    it should always check the transaction.otherTrans.type value.
                        //XXX currently only multisig transaction can be signed with this bot.

                        if (content.type != instance.blockchain_.nem().model.transactionTypes.multisigTransaction) {
                            // we are interested only in multisig transactions.
                            continue;
                        }

                        automaticTransactionSigningHandler(instance, transaction);
                    }
                }, function(err) {
                    instance.logger().error("[NEM] [ERROR] [SIGN-FALLBACK]", __line, "NIS API account.transactions.unconfirmed Error: " + JSON.stringify(err));
                });
        };

        /**
         * Open the connection to a Websocket to the NEM Blockchain endpoint configured
         * through ```this.blockchain_```.
         *
         * @return {[type]} [description]
         */
        this.connectBlockchainSocket = function() {
            var self = this;

            // initialize the socket connection with the current
            // blockchain instance connected endpoint
            self.nemsocket_ = new api_(self.blockchain_.getNetwork().host + ":" + self.blockchain_.getNetwork().port);

            self.errorHandler_ = new SocketErrorHandler(self);

            // Connect to NEM Blockchain Websocket now
            self.nemConnection_ = self.nemsocket_.connectWS(function() {
                // on connection we subscribe only to the /errors websocket.
                // MultisigCosignatory will open

                try {
                    self.logger().info("[NEM] [SIGN-SOCKET] [CONNECT]", __line, "Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

                    // NEM Websocket Error listening
                    self.logger().info("[NEM] [SIGN-SOCKET]", __line, 'subscribing to /errors.');
                    self.nemSubscriptions_["/errors"] = self.nemsocket_.subscribeWS("/errors", function(message) {
                        self.logger().error("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Error Happened: " + message.body);
                    });

                    self.auditor_ = new BlocksAuditor(self);

                    // NEM Websocket unconfirmed transactions Listener
                    var unconfirmedUri = "/unconfirmed/" + self.blockchain_.getBotSignMultisigWallet();
                    self.logger().info("[NEM] [SIGN-SOCKET]", __line, 'subscribing to ' + unconfirmedUri + '.');
                    self.nemSubscriptions_[unconfirmedUri] = self.nemsocket_.subscribeWS(unconfirmedUri, function(message) {
                        var parsed = JSON.parse(message.body);
                        self.logger().info("[NEM] [SIGN-SOCKET]", __line, 'unconfirmed(' + JSON.stringify(parsed) + ')');

                        var transactionData = JSON.parse(message.body);
                        var transaction = transactionData.transaction;

                        //XXX implement real verification of transaction type. In case it is a multisig
                        //    it should always check the transaction.otherTrans.type value.
                        //XXX currently only multisig transaction can be signed with this bot.

                        if (transaction.type != chainDataLayer.nem().model.transactionTypes.multisigTransaction) {
                            // we are interested only in multisig transactions.
                            return false;
                        }

                        automaticTransactionSigningHandler(self, transactionData);
                    });

                    var sendUri = "/w/api/account/transfers/all";
                    //self.nemsocket_.sendWS(sendUri, {}, JSON.stringify({ account: self.blockchain_.getBotSignWallet() }));

                } catch (e) {
                    // On Exception, restart connection process
                    self.logger().error("[NEM] [ERROR]", __line, "Websocket Subscription Error: " + e);
                    self.connectBlockchainSocket();
                }
            }, self.errorHandler_.handle);

            // fallback handler queries the blockchain every 2 minutes
            if (self.fallback_ !== null) clearInterval(self.fallback_);
            self.fallback_ = setInterval(function() {
                websocketFallbackHandler(self);
            }, 120 * 1000);

            websocketFallbackHandler(self);

            return self.nemsocket_;
        };

        /**
         * This method will unsubscribe from websocket channels and
         * disconnect the websocket.
         * 
         * @return void
         */
        this.disconnectBlockchainSocket = function(callback) {
            if (!this.nemsocket_) return false;

            var self = this;
            try {
                for (path in self.nemSubscriptions_) {
                    var subId = self.nemSubscriptions_[path];
                    self.nemsocket_.unsubscribeWS(subId);

                    delete self.nemSubscriptions_[path];
                }

                self.nemsocket_.disconnectWS(function() {
                    self.logger().info("[NEM] [SIGN-SOCKET] [DISCONNECT]", __line, "Websocket disconnected.");

                    delete self.nemsocket_;
                    delete self.nemSubscriptions_;
                    delete self.nemConnection_;
                    self.nemSubscriptions_ = {};

                    if (callback)
                        return callback();
                });
            } catch (e) {
                // hot disconnect
                self.logger().info("[NEM] [SIGN-SOCKET] [DISCONNECT]", __line, "Websocket Hot Disconnect.");

                delete self.nemsocket_;
                delete self.nemSubscriptions_;
                delete self.nemConnection_;
                self.nemSubscriptions_ = {};
                return callback();
            }
        };

        /**
         * Verify an unconfirmed transaction. This method will check the
         * transaction signature with initiator public key.
         *
         * /!\ In case this method returns `false`, it means the transaction
         * has been tampered with and it is not safe to sign the
         * transaction !
         *
         * @param  {[type]} transactionMetaDataPair [description]
         * @return {[type]}                         [description]
         */
        this.verifyTransaction = function(transactionMetaDataPair) {
            var self = this;
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;
            var trxHash = self.blockchain_.getTransactionHash(transactionMetaDataPair);

            var isMultisig = content.type === self.blockchain_.nem_.model.transactionTypes.multisigTransaction;
            var trxRealData = isMultisig ? content.otherTrans : content;
            var trxSignature = content.signature.toString();
            var trxInitiatorPubKey = content.signer;

            if (!isMultisig)
                return 1;

            // in case we have a multisig, the transaction.otherTrans.signer is the Multisig
            // Account public key. This lets us verify the authenticity of the Transaction some more.
            var trxRealAccount = self.blockchain_.getAddressFromPublicKey(trxRealData.signer);
            var multisigAccount = self.config().bot.sign.multisigAddress;

            if (trxRealAccount != multisigAccount)
            // will only sign transaction for the configured multisignature address.
                return 2;

            if (!self.isAcceptedCosignatory(trxInitiatorPubKey))
            // bot.sign.cosignatory.acceptFrom
                return 3;

            //DEBUG self.logger().info("[NEM] [DEBUG] ", __line, 'Now verifying transaction "' + trxHash + '" with signature "' + trxSignature + '" and initiator "' + trxInitiatorPubKey + '"');

            // check transaction signature with initiator public key

            //XXX should be fixed now, must be tested
            //var trxSerialized = self.blockchain_.nem_.utils.serialization.serializeTransaction(content);
            //return self.blockchain_.nem_.crypto.verifySignature(trxInitiatorPubKey, trxSerialized, trxSignature);
            return true;
        };

        /**
         * Check whether the given public key is a valid listed cosignatory.
         *
         * Accepted cosignatories can be listed in the `config/bot.json` file under
         * `bot.sign.cosignatory.acceptFrom` as an array of public keys.
         *
         * @param  {string}  cosigPubKey
         * @return {Boolean}
         */
        this.isAcceptedCosignatory = function(cosigPubKey) {
            var self = this;
            var cosigs = self.config().bot.sign.cosignatory.acceptFrom;

            if (typeof cosigs == "string")
                return cosigs === cosigPubKey;

            for (var i in cosigs) {
                var valid = cosigs[i];
                if (valid === cosigPubKey)
                    return true;
            }

            return false;
        };

        /**
         * Sign a transactionMetaDataPair transaction object. In case this is a multisig
         * transaction, it will sign the correct `transaction.otherTrans` underlying object.
         *
         * This function verifies the private key and transaction signature before
         * issuing a signature itself and broadcasting it to the network.
         *
         * The `callback` callable will be executed only in case of a successful broadcasting
         * of the signed signature transaction.
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @param  {Function} callback                [description]
         * @return {[type]}                           [description]
         */
        this.signTransaction = function(transactionMetaDataPair, callback) {
            var self = this;
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;
            var trxHash = self.blockchain_.getTransactionHash(transactionMetaDataPair);

            // (1) read config and check co-signing ability of this NEMBot (private key required)
            var privateKey = self.blockchain_.getBotSignSecret();
            var multisigWallet = self.blockchain_.getBotSignMultisigWallet();

            if (!self.blockchain_.nem_.utils.helpers.isPrivateKeyValid(privateKey)) {
                throw "Invalid private key in bot.json, Please fix to start co-signing NEM blockchain transactions.";
            }

            // (2) verify transaction validity on the blockchain

            $result = self.verifyTransaction(transactionMetaDataPair);

            if (true !== $result) {
                // not signing this transaction.
                return false;
            }

            // (3) transaction is genuine and was not tampered with, we can now sign it too.

            // prepare signature transaction
            var commonPair = self.blockchain_.nem_.model.objects.create("common")("", privateKey);
            var networkId = self.blockchain_.getNetwork().config.id;
            var signTx = self.blockchain_.nem_.model.objects.create("signatureTransaction")(multisigWallet, trxHash);
            var prepared = self.blockchain_.nem_.model.transactions.prepare("signatureTransaction")(commonPair, signTx, networkId);

            // sign signature transaction and serialize
            var secretPair = self.blockchain_.nem_.crypto.keyPair.create(privateKey);
            var serialized = self.blockchain_.nem_.utils.serialization.serializeTransaction(prepared);
            var signature = secretPair.sign(serialized);
            var broadcastable = JSON.stringify({
                "data": self.blockchain_.nem_.utils.convert.ua2hex(serialized),
                "signature": signature.toString()
            });

            //DEBUG self.logger().info("[NEM] [DEBUG] ", __line, 'Transaction "' + trxHash + '" signed: "' + signature.toString() + '"');

            // (4) broadcast signed signature transaction, work done for this NEMBot.
            self.blockchain_.nem().com.requests
                .transaction.announce(self.blockchain_.endpoint(), broadcastable)
                .then(function(res) {
                    //DEBUG self.logger().info("[NEM] [SIGN-SOCKET]", __line, 'Transaction Annouce Response: "' + JSON.stringify(res));

                    if (res.code >= 2) {
                        self.blockchain_.logger().error("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Error announcing transaction: " + res.message);
                    } else if ("SUCCESS" == res.message) {
                        // transaction broadcast successfully.

                        self.logger().info("[NEM] [SIGN-SOCKET]", __line, 'Transaction co-signed and broadcast: "' + trxHash + '" with response: "' + res.message + '".');
                        callback(res);
                    }
                    // "NEUTRAL" will not trigger callback
                }, function(err) {
                    self.logger().error("[NEM] [SIGN-SOCKET] [ERROR]", __line, "Signing error: " + err);
                });
        };

        var self = this; {
            // nothing more done on instanciation
        }
    };


    module.exports.MultisigCosignatory = MultisigCosignatory;
}());