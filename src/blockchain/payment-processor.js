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

    this.backend_   = null;
    this.channel_   = null;
    this.params_    = null;
    this.nemsocket_ = null;
    this.caughtTrxs_= null;
    this.nemsocket_ = new api_(this.blockchain_.nemHost + ":" + this.blockchain_.nemPort);
    this.socketById = {};

    this.logger = function()
    {
        return this.blockchain_.logger();
    };

    this.config = function()
    {
        return this.blockchain_.conf_;
    };

    this.getBlockchainSocket = function()
    {
        if (! this.nemsocket_) {
            this.connectBlockchainSocket();
        }

        return this.nemsocket_;
    };

    /**
     * Open the connection to a Websocket to the NEM Blockchain endpoint configured
     * through ```this.blockchain_```.
     *
     * @return {[type]} [description]
     */
    this.connectBlockchainSocket = function()
    {
        var self = this;

        // define helper for websocket error handling, the NEM Blockchain Socket
        // should be alive as long as the bot is running so we will always try
        // to reconnect, unless the bot has been stopped from running or has crashed.
        var websocketErrorHandler = function(error)
        {
            var regexp_LostConn = new RegExp(/Lost connection to/);
            if (regexp_LostConn.test(error)) {
                // connection lost, re-connect

                self.logger()
                    .info("PaymentProcessor", __line,
                          "[" + self.backend_.id + "] [NEM] [DROP] Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                self.connectBlockchainSocket();
                return true;
            }

            // uncaught error happened
            self.blockchain_.socketError("NEM Websocket Uncaught Error: " + error, "UNCAUGHT");
        };

        // define helper for handling incoming transactions. This helper is called from a callback
        // function provided to NEMPaymentChannel.matchTransactionToChannel and always has a ```paymentChannel``` set.
        // this helper function will emit the payment status update.
        var websocketChannelTransactionHandler = function(paymentChannel, transactionMetaDataPair, status, trxGateway)
        {
            var backendSocketId = paymentChannel.socketIds.pop();
            var forwardToSocket = null;

            if (! paymentChannel) {
                self.logger().info("PaymentProcessor", __line, '[NEM] [' + gateway + '] irrelevant ' + status + ' transaction with hash: ' + trxHash);
                return false; // irrelevant transaction
            }

            self.logger().info("PaymentProcessor", __line, '[NEM] [' + gateway + '] [TRX] Identified Relevant ' + status + ' Transaction for "' + paymentChannel.message + '" forwarded to "' + backendSocketId + '"');

            if (self.socketById.hasOwnProperty(backendSocketId)) {
                forwardToSocket = self.socketById[backendSocketId];
            }
            else self.logger().info("PaymentProcessor", __line, '[NEM] [WARNING] no backend socket available for Socket ID "' + backendSocketId + '"!');

            paymentChannel = PaymentChannel.acknowledgeTransaction(paymentChannel, transactionMetaDataPair, status);

            if (forwardToSocket) {
                self.emitPaymentUpdate(forwardToSocket, paymentChannel, status);
            }
        };

        // Connect to NEM Blockchain Websocket now
        this.nemsocket_.connectWS(function()
        {
            // on connection we subscribe only to the /errors websocket.
            // PaymentProcessor will open

            self.logger()
                .info("PaymentProcessor", __line,
                      "[NEM] [CONNECT] Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

            // NEM Websocket Error listening
            self.nemsocket_.subscribeWS("/errors", function(message)
            {
                self.logger()
                    .info("PaymentProcessor", __line,
                          "[NEM] [ERROR] Error Happened: " + message.body);
            });

            //XXX NEM Websocket new blocks Listener => Should verify confirmations about our payment channels.

            // NEM Websocket unconfirmed transactions Listener
            self.nemsocket_.subscribeWS("/unconfirmed/" + self.blockchain_.getReadBotWallet(), function(message)
            {
                self.logger().info("PaymentProcessor", __line, '[NEM] [SOCKET] unconfirmed(' + message.body + ')');

                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                PaymentChannel.matchTransactionToChannel(transactionData, "unconfirmed", function(paymentChannel)
                    {
                        websocketChannelTransactionHandler(paymentChannel, transactionData, "unconfirmed", "SOCKET");
                    });
            });

            // NEM Websocket confirmed transactions Listener
            self.nemsocket_.subscribeWS("/transactions/" + self.blockchain_.getReadBotWallet(), function(message)
            {
                self.logger().info("PaymentProcessor", __line, '[NEM] [TRX] transactions(' + message.body + ')');

                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                PaymentChannel.matchTransactionToChannel(transactionData, "confirmed", function(paymentChannel)
                    {
                        websocketChannelTransactionHandler(paymentChannel, transactionData, "confirmed", "SOCKET");
                    });
            });

        }, websocketErrorHandler);

        return this;
    };

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
    this.forwardPaymentUpdates = function(forwardedToSocket, paymentChannel, params)
    {
        var self = this;

        // register socket to make sure also websockets events can be forwarded.
        if (! this.socketById.hasOwnProperty(forwardedToSocket.id)) {
            this.socketById[forwardedToSocket.id] = forwardedToSocket;
        }

        // configure timeout of websocket fallback
        var startTime_ = new Date().valueOf();
        var duration_  = typeof params != 'undefined' && params.duration ? params.duration : this.blockchain_.conf_.bot.read.duration;

        duration_ = parseInt(duration_);
        if (isNaN(duration_) || duration_ <= 0)
            duration_ =  15 * 60 * 1000;

        var endTime_ = startTime_ + duration_;

        // We will now configure a websocket fallback because the backend has requested
        // to open a payment channel. Handling websocket communication is done when connecting
        // to the Blockchain Sockets so here we only need to provide with a Fallback for this
        // particular payment channel otherwize it would get very traffic intensive.

        // define fallback in case websocket does not catch transaction!
        var websocketFallbackHandler = function(processor)
        {
            // XXX should also check the Block Height and Last Block to know whether there CAN be new data.

            // read the payment channel recipient's incoming transaction to check whether the Websocket
            // has missed any (happens maybe only on testnet, but this is for being sure.). The same event
            // will be emitted in case a transaction is found un-forwarded.
            processor.blockchain_.nem().com.requests.account.incomingTransactions(processor.blockchain_.endpoint(), processor.channel_.getRecipient())
                .then(function(res)
            {
                var incomings = res;

                for (var i in incomings) {
                    var transaction = incomings[i];
                    var meta    = transaction.meta;
                    var content = transaction.transaction;
                    var trxHash = processor.getTransactionHash(transaction);

                    PaymentChannel.matchTransactionToChannel(transactionData, "confirmed", function(paymentChannel)
                        {
                            websocketChannelTransactionHandler(paymentChannel, transactionData, "confirmed", "HTTP");
                        });
                }
            });
        };

        // fallback handler queries the blockchain every 20 seconds
        var fallbackInterval = setInterval(function()
        {
            websocketFallbackHandler(self);
        }, 30 * 1000);

        setTimeout(function() {
            clearInterval(fallbackInterval);

            // closing fallback communication channel, update one more time.
            websocketFallbackHandler(self);
        }, duration_);

        // check balance now - do not wait 30 seconds
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
    this.emitPaymentUpdate = function(transactionData, paymentChannel, status)
    {
        //XXX implement notifyUrl - webhooks features
        var self    = this;
        var trxHash = self.getTransactionHash(transactionData);
        var meta    = transactionData.meta;
        var content = transactionData.transaction;

        // update the payment state in our database
        if ("confirmed" == status) {
            paymentChannel.amountPaid += content.amount;
            paymentChannel.amountUnconfirmed -= content.amount;
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
            paymentChannel.amountUnconfirmed += content.amount;
            paymentChannel.status = "identified";
        }

        // and upon save, emit payment status update event to the Backend.
        paymentChannel = paymentChannel.addTransaction(transactionData);
        paymentChannel.updatedAt = new Date().valueOf();
        paymentChannel.save(function(err, paymentChannel)
            {
                var eventData = paymentChannel.toDict();

                // notify our socket about the update (private communication NEMBot > Backend)
                self.backend_.emit("nembot_payment_status_update", JSON.stringify(eventData));
                self.logger().info("PaymentProcessor", __line, '[' + self.backend_.id + '] [BOT] payment_status_update(' + JSON.stringify(eventData) + ')');
            });

        return paymentChannel;
    };

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


module.exports.PaymentProcessor = PaymentProcessor;
}());
