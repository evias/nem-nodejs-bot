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
var PaymentProcessor = function(chainDataLayer)
{
    var api_  = nemAPI;

    this.blockchain_ = chainDataLayer;

    /**
     * This method OPENS a payment channel for the given backendSocket. Data about the payer
     * and the recipient are store in the `paymentChannel` model instance. The `params` field
     * can be used to provide a `duration` in milliseconds.
     *
     * This process will open a NEM Websocket Connection (Bot > NEM) handling payment updates and forwarding
     * them back to the `backendSocket` Websocket (Bot > Backend).
     *
     * A fallback for Websockets will be implemented with HTTP requests using the nem-sdk library because
     * it seems Websockets sometimes don't catch some transactions. (bug reported in NanoWallet already)
     *
     * @param  {object} backendSocket
     * @param  {NEMPaymentChannel} paymentChannel
     * @param  {object} params
     * @return {NEMPaymentChannel}
     */
    this.listenForPayment = function(forwardedToSocket, paymentChannel)
    {
        var self = this;
        var backend_   = forwardedToSocket;
        var channel_   = paymentChannel;
        var params_    = params;
        var nemsocket_ = new api_(self.blockchain_.nemHost + ":" + self.blockchain_.nemPort);
        var caughtTrxs_= {};

        // configure timeout
        var startTime_ = new Date().valueOf();
        var duration_  = typeof params != 'undefined' && params.duration ? params.duration : conf_.bot.read.duration;

        duration_ = parseInt(duration_);
        if (isNaN(duration_) || duration_ <= 0)
            duration_ =  15 * 60 * 1000;

        var endTime_ = startTime + duration_;

        // define helper for websocket error handling
        var websocketErrorHandler = function(error)
        {
            var regexp_LostConn = new RegExp(/Lost connection to/);
            if (regexp_LostConn.test(error)) {
                // connection lost

                var thisTime = new Date().valueOf();
                if (thisTime >= endTime_)
                    return false; // drop connection

                self.blockchain_.socketLog("NEM Websocket Connection lost, re-connecting..", "DROP");
                self.listenForPayment(backend_, channel_, params_);
                return true;
            }

            // uncaught error happened
            self.blockchain_.socketError("NEM Websocket Uncaught Error: " + error, "UNCAUGHT");
        };

        // define fallback in case websocket does not catch transaction!
        var websocketFallbackHandler = function(paymentChannel)
        {
            // XXX should also check the Block Height and Last Block to know whether there CAN be new data.

            self.blockchain_.nem().com.requests.incomingTransactions(self.blockchain_.endpoint(), paymentChannel.recipientXEM)
            .then(function(res)
            {
                var incomings = res;

                for (var i in incomings) {
                    var content = incomings[i].transaction;
                    var meta    = incomings[i].meta;
                    var trxHash = self.getTransactionHash(incomings[i]);

                    var paymentData = {};
                    if (false === (paymentData = paymentChannel.matchTransactionData(content, "confirmed")))
                        continue; // transaction irrelevant for current `paymentChannel`

                    // check if Websocket caught this transaction (in confirmed state)
                    if (caughtTrxs_.hasOwnProperty(trxHash) && caughtTrxs_[trxHash].status == "confirmed")
                        continue; // transaction processed already.
                    else if (paymentChannel.transactionHashes && paymentChannel.transactionHashes.hasOwnProperty(trxHash))
                        continue; // transaction processed already (and saved to db ;).

                    caughtTrxs_[trxHash] = {status: "confirmed", time: new Date().valueOf()};
                    self.emitPaymentUpdate(backend_, paymentChannel, transactionData, eventData);
                }
            });
        };

        // fallback handler queries the blockchain every 20 seconds
        var fallbackInterval = setInterval(function()
        {
            websocketFallbackHandler(paymentChannel);
        }, 30 * 1000);

        setTimeout(function() {
            clearInterval(fallbackInterval);

            // closing channel, update one more time.
            websocketFallbackHandler(paymentChannel);
        }, duration_);

        nemsocket_.connectWS(function()
        {
            // on connection we subscribe to the needed NEM blockchain websocket channels.

            // always save all socket IDs
            paymentChannel = paymentChannel.addSocket(backend_);
            paymentChannel.save();

            // NEM Websocket Error listening (XXX)
            nemsocket_.subscribeWS("/errors", function(message) {
                self.socketError(message.body, "ERROR");
            });

            //XXX NEM Websocket new blocks Listener => Should verify confirmations about our payment channels.

            // NEM Websocket unconfirmed transaction Listener (Read Bot)
            nemsocket_.subscribeWS("/unconfirmed/" + self.getBotReadWallet(), function(message) {

                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                var paymentData = {};
                if (false === (paymentData = paymentChannel.matchTransactionData(transaction, "unconfirmed")))
                    return false;

                // check if fallback caught this transaction before websocket (very unlikely)
                if (caughtTrxs_.hasOwnProperty(trxHash))
                    continue; // transaction processed already (could be both unconfirmed or confirmed).
                else if (paymentChannel.transactionHashes && paymentChannel.transactionHashes.hasOwnProperty(trxHash))
                    continue; // transaction processed already (and saved to db ;).

                caughtTrxs_[trxHash] = {status: "unconfirmed", time: new Date().valueOf()};
                self.emitPaymentUpdate(backend_, paymentChannel, transactionData, paymentData, "unconfirmed");
            });

            nemsocket_.subscribeWS("/transactions/" + self.getBotReadWallet(), function(message) {
                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                var paymentData = {};
                if (false === (paymentData = paymentChannel.matchTransactionData(transaction, "confirmed")))
                    return false;

                // check if fallback caught this transaction before websocket (very unlikely)
                if (caughtTrxs_.hasOwnProperty(trxHash) && caughtTrxs_[trxHash].status == "confirmed")
                    continue; // transaction processed already
                else if (paymentChannel.transactionHashes && paymentChannel.transactionHashes.hasOwnProperty(trxHash))
                    continue; // transaction processed already (and saved to db ;).

                caughtTrxs_[trxHash] = {status: "confirmed", time: new Date().valueOf()};
                self.emitPaymentUpdate(backend_, paymentChannel, transactionData, paymentData, "confirmed");
            });

        }, websocketErrorHandler);
    };

    /**
     * This method EMITS a payment status update back to the Backend connected
     * to this NEMBot.
     *
     * It will also save the transaction data into the NEMBotDB.NEMPaymentChannel
     * model and save to the database.
     *
     * @param  {socket.io} backendSocket
     * @param  {NEMPaymentChannel} paymentChannel
     * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionData
     * @param  {object} paymentData
     * @param  {string} status
     * @return {NEMPaymentChannel}
     */
    this.emitPaymentUpdate = function(backendSocket, paymentChannel, transactionData, paymentData, status)
    {
        var eventData = paymentData;
        eventData.status = status;

        // Websocket is ALWAYS notified of a payment status update
        backendSocket.emit("nembot_payment_status_update", JSON.stringify(eventData));

        //XXX implement notifyUrl - webhooks features

        if ("confirmed" == status) {
            paymentChannel.amountPaid += transaction.amount;
            paymentChannel.amountUnconfirmed -= transaction.amount;
            if (paymentChannel.amountUnconfirmed < 0)
                paymentChannel.amountUnconfirmed = 0;

            paymentChannel.status = "paid_partly";
            if (paymentChannel.amount <= paymentChannel.amountPaid) {
                paymentChannel.status = "paid";
                paymentChannel.isPaid = true;
                paymentChannel.paidAt = new Date().valueOf();
            }
        }
        else if ("unconfirmed" == status) {
            paymentChannel = paymentChannel.addTransaction(transactionData);
            paymentChannel.amountUnconfirmed += transaction.amount;
            paymentChannel.status = "identified";
            paymentChannel.save();
        }

        // update our bot database too
        paymentChannel = paymentChannel.addTransaction(transactionData);
        paymentChannel.save();

        return paymentChannel;
    }

    /**
     * Read the Transaction Hash from a given TransactionMetaDataPair
     * object (gotten from NEM websockets or API).
     *
     * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionData
     * @return {string}
     */
    this.getTransactionHash = function(transactionData)
    {
        var meta    = transactionData.meta;
        var content = transactionData.transaction;

        var trxHash = meta.hash.data;
        if (meta.innerHash.data && meta.innerHash.data.length)
            trxHash = meta.innerHash.data;

        return trxHash;
    };

    var self = this;
    {
        // nothing more done on instanciation
    }
};


module.exports.service = service;
}());
