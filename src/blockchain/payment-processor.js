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

    /**
     * class PaymentProcessor implements a simple payment processor using the
     * NEM Blockchain and Websockets.
     *
     * This payment processor links a PAYMENT to a pair consisting of:
     *     - ```sender``` (XEM address)
     *     - ```message``` (unique invoice number)
     *
     * Upgrading this to not **need** the ```message``` as an obligatory field
     * of Payments should be trivial enough but is not the goal of this first
     * implementation.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var PaymentProcessor = function(chainDataLayer) {
        var api_ = nemAPI;

        this.blockchain_ = chainDataLayer;
        this.db_ = this.blockchain_.getDatabaseAdapter();

        this.nemsocket_ = null;
        this.backend_ = null;
        this.channel_ = null;
        this.params_ = null;
        this.caughtTrxs_ = null;
        this.socketById = {};
        this.nemConnection_ = null;
        this.nemSubscriptions_ = {};
        this.confirmedTrxes = {};
        this.unconfirmedTrxes = {};
        this.transactionPool = {};

        this.auditor_ = null;
        this.moduleName = "pay-socket";
        this.logLabel = "PAY-SOCKET";

        this.options_ = {
            mandatoryMessage: true
        };

        this.logger = function() {
            return this.blockchain_.logger();
        };

        this.config = function() {
            return this.blockchain_.conf_;
        };

        // define helper for handling incoming transactions. This helper is called from a callback
        // function provided to NEMPaymentChannel.matchTransactionToChannel and always has a ```paymentChannel``` set.
        // this helper function will emit the payment status update.
        var websocketChannelTransactionHandler = function(instance, paymentChannel, transactionMetaDataPair, status, trxGateway) {
            var backendSocketId = paymentChannel.socketIds[paymentChannel.socketIds.length - 1];
            var forwardToSocket = null;

            var invoice = paymentChannel.message && paymentChannel.message.length ? paymentChannel.message : paymentChannel.getPayer();
            var trxHash = transactionMetaDataPair.meta.hash.data;
            if (transactionMetaDataPair.meta.innerHash.data && transactionMetaDataPair.meta.innerHash.data.length)
                trxHash = transactionMetaDataPair.meta.innerHash.data;

            if (instance.socketById.hasOwnProperty(backendSocketId)) {
                forwardToSocket = instance.socketById[backendSocketId];
            } else
                forwardToSocket = backendSocketId;
            //DEBUG instance.logger().warn("[NEM] [WARNING]", __line, 'no backend socket available for Socket ID "' + backendSocketId + '"!');

            // save this transaction in our history
            instance.db_.NEMPaymentChannel
                .acknowledgeTransaction(paymentChannel, transactionMetaDataPair, status, function(paymentChannel) {
                    if (paymentChannel !== false) {
                        // transaction has just been processed by acknowledgeTransaction!
                        instance.logger().info("[NEM] [TRX] [" + trxGateway + "] ", __line, 'Identified Relevant ' + status + ' Transaction for "' + invoice + '" with hash "' + trxHash + '" forwarded to "' + backendSocketId + '"');

                        // Payment is relevant - emit back payment status update
                        instance.emitPaymentUpdate(forwardToSocket, paymentChannel, status);
                    }
                });
        };

        // define fallback in case websocket does not catch transaction!
        //XXX function documentation
        var websocketFallbackHandler = function(instance) {
            // start recursion for loading more than 25 transactions
            // the callback will be executed only after reading ALL
            // transactions (paginating by steps of 25 transactions).
            instance.fetchPaymentDataFromBlockchain(null, function(instance) {
                // we can now fetch all DB entries for the fetched transactions
                // in order to be able to match transactions to Invoices.
                var query = {
                    status: "confirmed",
                    transactionHash: {
                        $in: Object.getOwnPropertyNames(instance.transactionPool)
                    }
                };

                instance.db_.NEMTransactionPool.find(query, function(err, entries) {
                        if (err) {
                            instance.logger().error("[NEM] [ERROR] [PAY-FALLBACK]", __line, "Error reading NEMTransactionPool: " + err);
                            // error happened
                            return false;
                        }

                        var unprocessed = instance.transactionPool;
                        if (entries) {
                            var processed = {};
                            for (var i = 0; i < entries.length; i++) {
                                var entry = entries[i];
                                processed[entry.transactionHash] = true;
                            }

                            var keysPool = Object.getOwnPropertyNames(instance.transactionPool);
                            var keysDb = Object.getOwnPropertyNames(processed);

                            unprocessed = keysPool.filter(function(hash, idx) {
                                return keysDb.indexOf(hash) < 0;
                            });

                            if (!unprocessed.length)
                                return false;
                        }

                        //DEBUG instance.logger().info("[NEM] [PAY-FALLBACK] [TRY] ", __line, "trying to match " + unprocessed.length + " unprocessed transactions from " + instance.blockchain_.getBotReadWallet() + ".");

                        for (var j = 0; j < unprocessed.length; j++) {
                            var trxHash = unprocessed[j];
                            var transaction = instance.transactionPool[trxHash];

                            if (!transaction)
                                continue;

                            var creation = new self.db_.NEMTransactionPool({
                                status: "confirmed",
                                transactionHash: trxHash,
                                createdAt: new Date().valueOf()
                            });
                            creation.save();

                            instance.db_.NEMPaymentChannel.matchTransactionToChannel(instance.blockchain_, transaction, function(paymentChannel, trx) {
                                if (paymentChannel !== false) {
                                    websocketChannelTransactionHandler(instance, paymentChannel, trx, "confirmed", "PAY-FALLBACK");
                                }
                            });
                        }
                    },
                    function(err) {
                        instance.logger().error("[NEM] [PAY-FALLBACK] [ERROR] ", __line, "Error reading NEMTransactionPool: " + err);
                    });
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

            // define helper for websocket error handling, the NEM Blockchain Socket
            // should be alive as long as the bot is running so we will always try
            // to reconnect, unless the bot has been stopped from running or has crashed.
            var websocketErrorHandler = function(error) {
                var regexp_LostConn = new RegExp(/Lost connection to/);
                if (regexp_LostConn.test(error)) {
                    // connection lost, re-connect

                    self.logger()
                        .warn("[NEM] [PAY-SOCKET] [DROP]", __line, "Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                    self.connectBlockchainSocket();
                    return true;
                }
                //XXX ECONNREFUSED => switch node

                // uncaught error happened
                self.logger()
                    .error("[NEM] [PAY-SOCKET] [ERROR]", __line, "Uncaught Error: " + error);
            };

            // Connect to NEM Blockchain Websocket now
            self.nemConnection_ = self.nemsocket_.connectWS(function() {
                // on connection we subscribe only to the /errors websocket.
                // PaymentProcessor will open
                try {
                    self.logger()
                        .info("[NEM] [PAY-SOCKET] [CONNECT]", __line,
                            "Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

                    // NEM Websocket Error listening
                    self.logger().info("[NEM] [PAY-SOCKET]", __line, 'subscribing to /errors.');
                    self.nemSubscriptions_["/errors"] = self.nemsocket_.subscribeWS("/errors", function(message) {
                        self.logger()
                            .error("[NEM] [PAY-SOCKET] [ERROR]", __line,
                                "Error Happened: " + message.body);
                    });

                    self.auditor_ = new BlocksAuditor(self);

                    var unconfirmedUri = "/unconfirmed/" + self.blockchain_.getBotReadWallet();
                    var confirmedUri = "/transactions/" + self.blockchain_.getBotReadWallet();
                    var sendUri = "/w/api/account/transfers/all";

                    // NEM Websocket unconfirmed transactions Listener
                    self.logger().info("[NEM] [PAY-SOCKET]", __line, 'subscribing to /unconfirmed/' + self.blockchain_.getBotReadWallet() + '.');
                    self.nemSubscriptions_[unconfirmedUri] = self.nemsocket_.subscribeWS(unconfirmedUri, function(message) {
                        var parsed = JSON.parse(message.body);
                        self.logger().info("[NEM] [PAY-SOCKET]", __line, 'unconfirmed(' + JSON.stringify(parsed) + ')');

                        var transactionData = JSON.parse(message.body);
                        var transaction = transactionData.transaction;
                        var trxHash = self.blockchain_.getTransactionHash(transactionData);

                        self.db_.NEMTransactionPool.findOne({ transactionHash: trxHash }, function(err, entry) {
                            if (err || entry)
                            // error OR entry FOUND => transaction not processed this time.
                                return false;

                            var creation = new self.db_.NEMTransactionPool({
                                status: "unconfirmed",
                                transactionHash: trxHash,
                                createdAt: new Date().valueOf()
                            });
                            creation.save();

                            self.db_.NEMPaymentChannel.matchTransactionToChannel(self.blockchain_, transactionData, function(paymentChannel) {
                                if (paymentChannel !== false) {
                                    websocketChannelTransactionHandler(self, paymentChannel, transactionData, "unconfirmed", "SOCKET");
                                }
                            });
                        });
                    });

                    // NEM Websocket confirmed transactions Listener
                    self.logger().info("[NEM] [PAY-SOCKET]", __line, 'subscribing to /transactions/' + self.blockchain_.getBotReadWallet() + '.');
                    self.nemSubscriptions_[confirmedUri] = self.nemsocket_.subscribeWS(confirmedUri, function(message) {
                        var parsed = JSON.parse(message.body);
                        self.logger().info("[NEM] [PAY-SOCKET]", __line, 'transactions(' + JSON.stringify(parsed) + ')');

                        var transactionData = JSON.parse(message.body);
                        var transaction = transactionData.transaction;
                        var trxHash = self.blockchain_.getTransactionHash(transactionData);

                        // this time also include "status" filtering.
                        self.db_.NEMTransactionPool.findOne({ status: "confirmed", transactionHash: trxHash }, function(err, entry) {
                            if (err || entry)
                            // error OR entry FOUND => transaction not processed this time.
                                return false;

                            var creation = new self.db_.NEMTransactionPool({
                                status: "confirmed",
                                transactionHash: trxHash,
                                createdAt: new Date().valueOf()
                            });
                            creation.save();

                            self.db_.NEMPaymentChannel.matchTransactionToChannel(self.blockchain_, transactionData, function(paymentChannel) {
                                if (paymentChannel !== false) {
                                    websocketChannelTransactionHandler(self, paymentChannel, transactionData, "confirmed", "SOCKET");
                                }
                            });
                        });
                    });

                    self.nemsocket_.sendWS(sendUri, {}, JSON.stringify({ account: self.blockchain_.getBotReadWallet() }));

                } catch (e) {
                    // On Exception, restart connection process
                    self.connectBlockchainSocket();
                }

            }, websocketErrorHandler);

            return self.nemsocket_;
        };

        /**
         * This method adds a new backend Socket to the current available Socket.IO
         * client instances. This is used to forward payment status updates event
         * back to the Backend which will then forward it to the Frontend Application
         * or Game.
         *
         * This method also opens a PAY-FALLBACK HTTP/JSON NIS API handler to query the
         * blockchain every minute for new transactions that might be relevant to our
         * application or game.
         *
         * @param  {object} backendSocket
         * @param  {NEMPaymentChannel} paymentChannel
         * @param  {object} params
         * @return {NEMPaymentChannel}
         */
        this.forwardPaymentUpdates = function(forwardedToSocket, paymentChannel, params) {
            //DEBUG this.logger().info("[BOT] [DEBUG] [" + forwardedToSocket.id + "]", __line, "forwardPaymentUpdates(" + JSON.stringify(params) + ")");

            // register socket to make sure also websockets events can be forwarded.
            if (!this.socketById.hasOwnProperty(forwardedToSocket.id)) {
                this.socketById[forwardedToSocket.id] = forwardedToSocket;
            }

            // configure timeout of websocket fallback
            var startTime_ = new Date().valueOf();
            var duration_ = typeof params != 'undefined' && params.duration ? params.duration : this.blockchain_.conf_.bot.read.duration;

            duration_ = parseInt(duration_);
            if (isNaN(duration_) || duration_ <= 0)
                duration_ = 15 * 60 * 1000;

            var endTime_ = startTime_ + duration_;
            var self = this;

            // fallback handler queries the blockchain every 5 minutes
            // ONLY IN CASE THE BLOCKS WEBSOCKET HAS NOT FILLED DATA FOR
            // 5 MINUTES ANYMORE (meaning the websocket connection is buggy).
            var fallbackInterval = setInterval(function() {
                self.db_.NEMBlockHeight.find({ moduleName: "pay-socket" }, [], { limit: 1, sort: { createdAt: -1 } }, function(err, lastBlock) {
                    var nowTime = new Date().valueOf();
                    if (lastBlock.createdAt < (nowTime - 5 * 60 * 1000)) {
                        // last block is 5 minutes old, use the FALLBACK!
                        websocketFallbackHandler(self);
                    }
                });
            }, 300 * 1000);

            // when opening a channel, we should always check whether the Invoice is Paid or 
            // if the Invoice needs any update.
            websocketFallbackHandler(self);
        };

        /**
         * This method EMITS a payment status update back to the Backend connected
         * to this NEMBot.
         *
         * It will also save the transaction data into the NEMBotDB.NEMPaymentChannel
         * model and save to the database.
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionData
         * @param  {object} paymentData
         * @param  {string} status
         * @return {NEMPaymentChannel}
         */
        this.emitPaymentUpdate = function(forwardToSocket, paymentChannel, status) {
            //XXX implement notifyUrl - webhooks features
            var eventData = paymentChannel.toDict();

            // notify our socket about the update (private communication NEMBot > Backend)
            if (typeof forwardToSocket == "object") {
                forwardToSocket.emit("nembot_payment_status_update", JSON.stringify(eventData));
                this.logger().info("[BOT] [" + forwardToSocket.id + "]", __line, "payment_status_update(" + JSON.stringify(eventData) + ")");
            } else if (typeof forwardToSocket == "string") {
                // no socket OBJECT available - send to socket ID

                this.blockchain_.getCliSocketIo()
                    .to(forwardToSocket)
                    .emit("nembot_payment_status_update", JSON.stringify(eventData));

                this.logger().info("[BOT] [" + forwardToSocket + "]", __line, "payment_status_update(" + JSON.stringify(eventData) + ")");
            }

            return paymentChannel;
        };

        /**
         * This method can be used to read all INCOMING TRANSACTIONS of the 
         * configured READ BOT. 
         * 
         * If any transaction is found to be relevant to the Payment Processor,
         * it will be acknowledged against the models and in the NEMTransactionPool.
         * 
         * @param   {PaymentProcessor}  instance
         * @param   {integer}           lastTrxRead     NEM Transaction ID
         * @return  void
         */
        this.fetchPaymentDataFromBlockchain = function(lastTrxRead = null, callback = null) {
            var self = this;

            // read the payment channel recipient's incoming transaction to check whether the Websocket
            // has missed any (happens maybe only on testnet, but this is for being sure.). The same event
            // will be emitted in case a transaction is found un-forwarded.
            self.blockchain_.nem()
                .com.requests.account.transactions
                .incoming(self.blockchain_.endpoint(), self.blockchain_.getBotReadWallet(), null, lastTrxRead)
                .then(function(res) {
                    //DEBUG self.logger().info("[DEBUG]", "[PACNEM CREDITS]", "Result from NIS API account.transactions.incoming: " + JSON.stringify(res.data));
                    //DEBUG self.logger().info("[DEBUG]", "[PACNEM CREDITS]", "Result from NIS API account.transactions.incoming: " + res.data.length + " Transactions.");
                    res = res.data;
                    var transactions = res;

                    lastTrxRead = self.processIncomingTransactions(transactions);

                    if (lastTrxRead !== false && 25 == transactions.length) {
                        // recursion..
                        // there may be more transactions in the past (25 transactions
                        // is the limit that the API returns). If we specify a hash or ID it
                        // will look for transactions BEFORE this hash or ID (25 before ID..).
                        // We pass transactions IDs because all NEM nodes support those, hashes are
                        // only supported by a subset of the NEM nodes.
                        self.fetchPaymentDataFromBlockchain(lastTrxRead, callback);
                    }

                    if (callback && (lastTrxRead === false || transactions.length < 25)) {
                        // done reading blockchain.

                        self.logger().info("[NEM] [PAY-FALLBACK] ", __line, "read a total of " + Object.getOwnPropertyNames(self.transactionPool).length + " transactions from " + self.blockchain_.getBotReadWallet() + ".");
                        callback(self);
                    }
                }, function(err) {
                    self.logger().error("[NEM] [ERROR] [PAY-FALLBACK]", __line, "NIS API account.transactions.incoming Error: " + err);
                });
        };

        /**
         * This method will acknowledge a chunk of (maximum) 25 transactions
         * and return a boolean with `false` when the reading process should 
         * be stopped. (less than 25 transactions read OR already read transaction)
         * 
         * @param   {Array}     transactions    NEM Transactions list
         * @return  {integer}   Last read NEM Transaction ID
         */
        this.processIncomingTransactions = function(transactions) {
            var lastTrxRead = null;
            var lastTrxHash = null;
            for (var i = 0; i < transactions.length; i++) {
                var transaction = transactions[i];
                lastTrxRead = this.blockchain_.getTransactionId(transaction);
                lastTrxHash = this.blockchain_.getTransactionHash(transaction);

                if (this.transactionPool.hasOwnProperty(lastTrxHash))
                    return false;

                this.transactionPool[lastTrxHash] = transaction;
            }

            return lastTrxRead;
        };

        var self = this; {
            // nothing more done on instanciation
        }
    };


    module.exports.PaymentProcessor = PaymentProcessor;
}());