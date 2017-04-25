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

var mongoose  = require('mongoose');
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
var NEMBotDB = function(config, io, chainDataLayer)
{
    var config_ = config;
    var socket_ = io;
    var blockchain_ = chainDataLayer;

    host = process.env['MONGODB_URI'] || process.env['MONGOLAB_URI'] || config.bot.db.uri || "mongodb://localhost/NEMBotDB";
    mongoose.connect(host, function(err, res)
        {
            if (err)
                console.log("ERROR with NEMBotDB DB (" + host + "): " + err);
            else
                console.log("NEMBotDB Database connection is now up with " + host);
        });

    this.NEMPaymentChannel_ = new mongoose.Schema({
        payerXEM: String,
        recipientXEM: String,
        socketIds: [String],
        transactionHashes: Object,
        notifyUrl: String,
        amount: {type: Number, min: 0},
        amountPaid: {type: Number, min: 0},
        amountUnconfirmed: {type: Number, min: 0},
        message: String,
        status: String,
        isPaid: {type: Boolean, default: false},
        paidAt: {type: Number, min: 0},
        createdAt: {type: Number, min: 0},
        updatedAt: {type: Number, min: 0}
    });

    this.NEMPaymentChannel_.methods = {
        toDict: function()
        {
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
        getPayer: function()
        {
            return this.payerXEM.replace(/-/g, "");
        },
        getRecipient: function()
        {
            return this.recipientXEM.replace(/-/g, "");
        },
        getQRData: function()
        {
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
        matchTransactionData: function(transaction, status, obligatoryMessage)
        {
            if (! transaction || transaction.recipient != this.recipientXEM)
                return false;

            if (transaction.type != blockchain_.nem().model.transactionTypes.transfer
                && transaction.type != blockchain_.nem().model.transactionTypes.multisigTransaction) {
                // we are interested only in transfer transactions
                // and multisig transactions.
                return false;
            }

            // try with a check of the signer's Public Key to identify the Sender.
            var signer = transaction.signer;
            var sender = blockchain_.nem().model.address.toAddress(signer, blockchain_.getNetwork().config.id);

            var paymentData = {};
            if (sender == this.payerXEM)
                paymentData.sender = this.payerXEM;
            else
                return false;

            if (obligatoryMessage === true && (!transaction.message || !transaction.message.payload))
                return false; // missing message in incoming transaction!

            if (transaction.message && transaction.message.type === 1) {
                // message available, check if it contains the `invoiceNumber`
                var payload = transaction.message.payload;
                var plain   = blockchain_.nem().utils.convert.hex2a(payload);

                if (plain != this.message) {
                    return false;
                }

                paymentData.invoice = this.message;
                return paymentData;
            }

            return obligatoryMessage !== true && paymentData.sender ? paymentData : false;
        },
        addTransaction: function(transaction)
        {
            var meta    = transaction.meta;
            var content = transaction.transaction;

            var trxHash = meta.hash.data;
            if (meta.innerHash.data && meta.innerHash.data.length)
                trxHash = meta.innerHash.data;

            if (! this.transactionHashes) {
                // no transactions recorded
                this.transactionHashes = {};
                this.transactionHashes[trxHash] = new Date().valueOf();
            }
            else if (! this.transactionHashes.hasOwnProperty(trxHash)) {
                // this transaction is not recorded
                this.transactionHashes[trxHash] = new Date().valueOf();
            }

            return this;
        },
        addSocket: function(socket)
        {
            if (! this.socketIds || ! this.socketIds.length)
                this.socketIds = [socket.id];
            else {
                var sockets = this.socketIds;
                sockets.push(socket.id);
                this.socketIds = sockets;
            }

            return this;
        }
    };

    // bind our Models classes
    this.NEMPaymentChannel = mongoose.model("NEMPaymentChannel", this.NEMPaymentChannel_);
};

module.exports.NEMBotDB = NEMBotDB;
module.exports.NEMPaymentChannel = NEMBotDB.NEMPaymentChannel;
}());

