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

    var mongoose = require('mongoose');
    var increment = require("mongoose-increment");

    /**
     * class NEMBotDB connects to a mongoDB database
     * either locally or using MONGODB_URI|MONGOLAB_URI env.
     *
     * This class also defines all available data
     * models for the bots.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var NEMBotDB = function(config, io, chainDataLayer) {
        var config_ = config;
        var socket_ = io;
        var blockchain_ = chainDataLayer;

        this.dbms_ = mongoose;

        var dbLog = function(filename, line, description) {
            var d = new Date();
            console.log(
                '[' + String(d).substr(0, 15) + ' ' + d.toLocaleTimeString() + ']\t' +
                "\u001b[32mINFO\u001b[0m" + '\t' + filename + '\t' + description);
        };

        var dbError = function(filename, line, description) {
            var d = new Date();
            console.log(
                '[' + String(d).substr(0, 15) + ' ' + d.toLocaleTimeString() + ']\t' +
                "\u001b[31mERROR\u001b[0m" + '\t' + filename + '\t:' + line + '\t' + description);
        };

        host = process.env['MONGODB_URI'] || process.env['MONGOLAB_URI'] || config.bot.db.uri || "mongodb://localhost/NEMBotDB";
        this.dbms_.connect(host, function(err, res) {
            if (err)
                console.log("ERROR with NEMBotDB DB (" + host + "): " + err);
            else
                console.log("NEMBotDB Database connection is now up with " + host);
        });

        this.NEMPaymentChannel_ = new this.dbms_.Schema({
            payerXEM: String,
            recipientXEM: String,
            socketIds: [String],
            transactionHashes: Object,
            unconfirmedHashes: Object,
            notifyUrl: String,
            amount: { type: Number, min: 0 },
            amountPaid: { type: Number, min: 0 },
            amountUnconfirmed: { type: Number, min: 0 },
            message: String,
            status: String,
            hasPayment: { type: Boolean, default: false },
            isPaid: { type: Boolean, default: false },
            paidAt: { type: Number, min: 0 },
            mosaicSlug: { type: String, default: "nem:xem" },
            createdAt: { type: Number, min: 0 },
            updatedAt: { type: Number, min: 0 }
        });

        this.NEMPaymentChannel_.methods = {
            toDict: function() {
                return {
                    sender: this.payerXEM,
                    recipient: this.recipientXEM,
                    amount: this.amount,
                    amountPaid: this.amountPaid,
                    amountUnconfirmed: this.amountUnconfirmed,
                    message: this.message,
                    status: this.status,
                    isPaid: this.isPaid
                };
            },
            getPayer: function() {
                return this.payerXEM.replace(/-/g, "");
            },
            getRecipient: function() {
                return this.recipientXEM.replace(/-/g, "");
            },
            getQRData: function() {
                // data for QR code generation
                var invoiceData = {
                    "v": blockchain_.getNetwork().isTest ? 1 : 2,
                    "type": 2,
                    "data": {
                        "addr": this.recipientXEM,
                        "amount": this.amount,
                        "msg": this.message,
                        "name": "NEMBot Payment " + this.message
                    }
                };

                return invoiceData;
            },
            addUnconfirmed: function(transactionMetaDataPair) {
                var meta = transactionMetaDataPair.meta;
                var trxHash = meta.hash.data;
                if (meta.innerHash.data && meta.innerHash.data.length)
                    trxHash = meta.innerHash.data;

                if (!this.unconfirmedHashes) {
                    // no transactions recorded
                    this.unconfirmedHashes = {};
                    this.unconfirmedHashes[trxHash] = new Date().valueOf();
                } else if (!this.unconfirmedHashes.hasOwnProperty(trxHash)) {
                    // this transaction is not recorded
                    this.unconfirmedHashes[trxHash] = new Date().valueOf();
                }

                return this.unconfirmedHashes;
            },
            addTransaction: function(transactionMetaDataPair) {
                var meta = transactionMetaDataPair.meta;
                var trxHash = meta.hash.data;
                if (meta.innerHash.data && meta.innerHash.data.length)
                    trxHash = meta.innerHash.data;

                if (!this.transactionHashes) {
                    // no transactions recorded
                    this.transactionHashes = {};
                    this.transactionHashes[trxHash] = new Date().valueOf();
                } else if (!this.transactionHashes.hasOwnProperty(trxHash)) {
                    // this transaction is not recorded
                    this.transactionHashes[trxHash] = new Date().valueOf();
                }

                return this.transactionHashes;
            },
            addSocket: function(socket) {
                if (!this.socketIds || !this.socketIds.length)
                    this.socketIds = [socket.id];
                else {
                    var sockets = this.socketIds;
                    sockets.push(socket.id);
                    this.socketIds = sockets;
                }

                return this;
            }
        };

        this.NEMPaymentChannel_.statics = {
            matchTransactionToChannel: function(chainDataLayer, transactionMetaDataPair, callback) {
                if (!transactionMetaDataPair)
                    return callback(false);

                var meta = transactionMetaDataPair.meta;
                var transaction = transactionMetaDataPair.transaction;

                if (!meta || !transaction)
                    return callback(false);

                if (transaction.type != chainDataLayer.nem().model.transactionTypes.transfer &&
                    transaction.type != chainDataLayer.nem().model.transactionTypes.multisigTransaction) {
                    // we are interested only in transfer transactions
                    // and multisig transactions.
                    return callback(false);
                }

                var recipient = transaction.recipient;
                var sender = chainDataLayer.getTransactionSender(transactionMetaDataPair);
                var trxHash = chainDataLayer.getTransactionHash(transactionMetaDataPair);

                // first try to load the channel by transaction hash
                var model = mongoose.model("NEMPaymentChannel");
                if (transaction.message && transaction.message.type === 1) {
                    // channel not found by Transaction Hash
                    // try to load the channel by transaction message

                    // message available, build it from payload and try loading a channel.
                    var plain = chainDataLayer.getTransactionMessage(transactionMetaDataPair);

                    // DEBUG dbLog("[NEM] [DEBUG]", __line, "Found transaction with message '" + plain + "': " + trxHash);

                    model.findOne({ message: plain.toUpperCase(), recipientXEM: recipient }, function(err, channel) {
                        if (!err && channel) {
                            // CHANNEL FOUND by Unencrypted Message
                            return callback(channel, transactionMetaDataPair);
                        } else if (!err && !chainDataLayer.conf_.bot.read.useTransactionMessageAlways) {
                            // could not identify channel by Message!
                            // try to load the channel by sender and recipient
                            model.findOne({ payerXEM: sender, recipientXEM: recipient }, function(err, channel) {
                                if (!err && channel) {
                                    // CHANNEL FOUND by Sender + Recipient
                                    return callback(channel, transactionMetaDataPair);
                                }
                            });
                        } else if (err) {
                            dbError(err);
                        }
                    });
                } else if (!chainDataLayer.conf_.bot.read.useTransactionMessageAlways) {
                    // can't load by message, load by Sender + Recipient
                    // try to load the channel by sender and recipient
                    // @see bot.json : bot.read.useTransactionMessageAlways

                    model.findOne({ payerXEM: sender, recipientXEM: recipient }, function(err, channel) {
                        if (!err && channel) {
                            // CHANNEL FOUND by Sender + Recipient
                            return callback(channel, transactionMetaDataPair);
                        } else if (err) {
                            dbError(err);
                        }
                    });
                }

                return callback(false);
            },

            acknowledgeTransaction: function(channel, transactionMetaDataPair, status, callback) {
                var meta = transactionMetaDataPair.meta;
                var transaction = transactionMetaDataPair.transaction;

                if (!meta || !transaction)
                    return callback(false);

                var trxHash = meta.hash.data;
                if (meta.innerHash.data && meta.innerHash.data.length)
                    trxHash = meta.innerHash.data;

                var trxes = status == 'unconfirmed' ? channel.unconfirmedHashes : channel.transactionHashes;

                if (trxes && Object.getOwnPropertyNames(trxes).length && trxes.hasOwnProperty(trxHash)) {
                    // transaction already processed in this status. (whether in unconfirmedHashes or transactionHashes
                    // is changed with the ```status``` variable)
                    return callback(false);
                }

                //XXX allow payments with different Mosaics than nem:xem
                // according to the `channel`.`mosaicSlug` field we might need to check
                // mosaics contents instead of `transaction`.`amount`.
                // NEMPaymentChannels should not change the amounts stored, the divisibility
                // of the Mosaic used for payments will be read from the blockchain when it 
                // is needed.
                //XXX

                // now "acknowledging" transaction: this means we will save the transaction amount
                // in the field corresponding to the given status. the unconfirmed amount cannot be trusted.
                // Firstly, because it represents an unconfirmed amount on the blockchain.
                // Secondly, because the websocket sometimes doesn't catch unconfirmed transactions and the
                // fallback works only for confirmed transactions!

                if ("confirmed" == status) {
                    channel.amountPaid += transaction.amount;

                    if (channel.unconfirmedHashes && channel.unconfirmedHashes.hasOwnProperty(trxHash)) {
                        // only delete from "unconfirmed" if it was saved to it.
                        delete channel.unconfirmedHashes[trxHash];
                        channel.amountUnconfirmed -= transaction.amount;
                    }

                    channel.status = "paid_partly";
                    if (channel.amount <= channel.amountPaid) {
                        // channel is now PAID - can be closed.
                        channel.status = "paid";
                        channel.isPaid = true;
                        channel.paidAt = new Date().valueOf();
                    }

                    channel.transactionHashes = channel.addTransaction(transactionMetaDataPair);
                    channel.hasPayment = true;
                } else if ("unconfirmed" == status) {
                    channel.amountUnconfirmed += transaction.amount;
                    channel.status = "unconfirmed";

                    channel.unconfirmedHashes = channel.addUnconfirmed(transactionMetaDataPair);
                }

                // and upon save, emit payment status update event to the Backend.
                channel.updatedAt = new Date().valueOf();
                channel.save(function(err, channel) {
                    return callback(channel);
                });
            }
        };

        this.NEMSignedTransaction_ = new this.dbms_.Schema({
            multisigXEM: String,
            cosignerXEM: String,
            transactionHash: String,
            nemNodeData: Object,
            transactionData: Object,
            amountXEM: { type: Number, min: 0 },
            createdAt: { type: Number, min: 0 },
            updatedAt: { type: Number, min: 0 }
        });

        this.NEMTransactionPool_ = new this.dbms_.Schema({
            status: String,
            transactionHash: String,
            createdAt: { type: Number, min: 0 },
            updatedAt: { type: Number, min: 0 }
        });

        this.NEMBlockHeight_ = new this.dbms_.Schema({
            blockHeight: { type: Number, min: 0 },
            moduleName: String,
            createdAt: { type: Number, min: 0 }
        });

        // bind our Models classes
        this.NEMPaymentChannel = this.dbms_.model("NEMPaymentChannel", this.NEMPaymentChannel_);
        this.NEMSignedTransaction = this.dbms_.model("NEMSignedTransaction_", this.NEMSignedTransaction_);
        this.NEMTransactionPool = this.dbms_.model("NEMTransactionPool", this.NEMTransactionPool_);
        this.NEMBlockHeight = this.dbms_.model("NEMBlockHeight", this.NEMBlockHeight_);
    };

    module.exports.NEMBotDB = NEMBotDB;
    module.exports.NEMPaymentChannel = NEMBotDB.NEMPaymentChannel;
    module.exports.NEMSignedTransaction = NEMBotDB.NEMSignedTransaction;
    module.exports.NEMTransactionPool = NEMBotDB.NEMTransactionPool;
    module.exports.NEMBlockHeight = NEMBotDB.NEMBlockHeight;
    module.exports.NEMBotDBMS = NEMBotDB.dbms_;
}());