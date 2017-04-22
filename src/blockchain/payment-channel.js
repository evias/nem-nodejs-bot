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

/**
 * class PaymentChannel handles management of OPEN payment channels.
 * This is not yet coupled to a database and provides only a in-app storage
 * for now.
 *
 * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
 */
var PaymentChannel = function(chainDataLayer, socket, data)
{
    var blockchain_ = chainDataLayer;
    var data_       = data;

    this.recipient  = data.recipient || blockchain_.getBotWallet();
    this.sender     = data.sender || "";
    this.message    = data.message || "";
    this.amount     = data.amount || 0;
    this.transacted = data.transacted || 0;
    this.maxAmount  = data.maxAmount || 0;
    this.socket     = socket;

    // define a helper for development debug of Payment Channels
    this.log = function(msg, type)
    {
        var logMsg = "[" + type + "] " + msg;
        blockchain_.logger().info("src/blockchain/payment-channel.js", __line, logMsg);
    };

    // define a helper for ERROR of Payment Channels
    this.error = function(msg, type)
    {
        var logMsg = "[" + type + "] " + msg;
        blockchain_.logger().error("src/blockchain/payment-channel.js", __line, logMsg);
    };

    this.close = function()
    {
        this.socket.emit("nembot_close_payment_channel", this.sender);
    };

    this.finish = function()
    {
        this.socket.emit("nembot_finish_payment_channel", this.sender);
    };

    this.toDict = function(key)
    {
        var dict = {
            sender: this.sender,
            recipient: this.recipient,
            amount: this.amount,
            transacted: this.transacted,
            message: this.message,
        };

        if (key && key.length) {
            var object = {};
            object[key] = dict;

            return object;
        }

        return dict;
    };

    this.isPaid = function()
    {
        return this.amount <= this.transacted;
    };

    this.extractPaymentData = function(transaction, amountField)
    {
        if (typeof amountField == "undefined" || ! amountField.length)
            amountField = "amountUnconfirmed";

        // this.transacted may contain data from db
        if (amountField == "amountPaid")
            this.transacted += transaction.amount;

        var paymentData = {};
        paymentData[amountField]  = transaction.amount;
        paymentData["transacted"] = this.transacted;

        // try with a check of the signer's Public Key to identify the Sender.
        var signer = transaction.signer;
        var sender = blockchain_.nem().model.address.toAddress(signer, blockchain_.getNetwork().config.id);

        if (sender == this.sender) {
            paymentData["sender"] = this.sender;
        }

        if (this.message.length && transaction.message && transaction.message.type === 1) {
            // message available, check if it contains the `invoiceNumber`
            var payload = transaction.message.payload;
            var plain   = blockchain_.nem().utils.convert.hex2a(payload);

            if (plain == this.message) {
                paymentData["invoice"] = this.message;
                return paymentData;
            }
        }

        return paymentData.sender ? paymentData : false;
    };

    this.sendPaymentStatusUpdate = function(paymentData, status)
    {
        var eventData = paymentData;
        eventData.status = status;

        this.log("nembot_payment_status_update(" + JSON.stringify(eventData) + ")", this.socket.id);
        this.socket.emit("nembot_payment_status_update", JSON.stringify(eventData));
    };

    var self = this;
    {
    }
};

var PaymentChannelRepository = function(db)
{
    this.db_ = db;

    this.fetchChannelByAddress = function(address, data, doOpen)
    {
        var emptyChannel = {};
        emptyChannel[address] = data;

        var channel = emptyChannel;
        try {
            try {
                // check if maybe the channel was not closed, re-use.
                channel = this.db_.getData("/channels/open/" + address);
            }
            catch (e) {
                // check if any active channel is available for this sender.
                channel = this.db_.getData("/channels/active/" + address);

                if (doOpen === true) {
                    // we found an ACTIVE channel, add it to the open pool.
                    this.db_.push("/channels/open", channel, false); // dont override, merge!
                }
            }
        }
        catch (e) {
            // channel does not exist yet, create now.
            channel = emptyChannel;
            channel.saved = true;

            this.db_.push("/channels/open", emptyChannel, false); // dont override, merge!
            this.db_.push("/channels/active", emptyChannel, false); // dont override, merge!
        }

        return channel;
    };

    this.closeChannel = function(address)
    {
        // delete this payment channel from the OPEN list (might still be /active)
        this.db_.delete("/channels/open/" + sender);
    };

    this.finishChannel = function(address)
    {
        var self    = this;
        var channel = self.fetchChannelByAddress(address, {}, false);

        self.closeChannel(address);
        try {
            var channelData = self.db_.getData("/channels/active/" + sender);
            self.db_.delete("/channels/active/" + sender);
        }
        catch (e) {}

        // archive this channel
        self.db.push("/archives", channel);
    };

    this.updateChannel = function(address, data)
    {
        this.db_.push("/channels/open/" + address, data, false);
        this.db_.push("/channels/active/" + address, data, false);
    };
};

module.exports.PaymentChannel = PaymentChannel;
module.exports.PaymentChannelRepository = PaymentChannelRepository;
}());
