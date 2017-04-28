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
    this.db_ = this.blockchain_.getDatabaseAdapter();

    this.backend_   = null;
    this.channel_   = null;
    this.params_    = null;
    this.nemsocket_ = null;
    this.caughtTrxs_= null;
    this.nemsocket_ = new api_(this.blockchain_.nemHost + ":" + this.blockchain_.nemPort);
    this.socketById = {};

    this.options_ = {
        mandatoryMessage: true
    };

    this.logger = function()
    {
        return this.blockchain_.logger();
    };

    this.config = function()
    {
        return this.blockchain_.conf_;
    };

    // define helper for handling incoming transactions. This helper is called from a callback
    // function provided to NEMPaymentChannel.matchTransactionToChannel and always has a ```paymentChannel``` set.
    // this helper function will emit the payment status update.
    var websocketChannelTransactionHandler = function(processor, paymentChannel, transactionMetaDataPair, status, trxGateway)
    {
        var backendSocketId = paymentChannel.socketIds.pop();
        var forwardToSocket = null;

        var invoice = paymentChannel.message && paymentChannel.message.length ? paymentChannel.message : paymentChannel.getPayer();


        if (processor.socketById.hasOwnProperty(backendSocketId)) {
            forwardToSocket = processor.socketById[backendSocketId];
        }
        else processor.logger().info("PaymentProcessor", __line, '[NEM] [WARNING] no backend socket available for Socket ID "' + backendSocketId + '"!');

        // save this transaction in our history
        paymentChannel = processor.db_.NEMPaymentChannel.acknowledgeTransaction(paymentChannel, transactionMetaDataPair, status);

        if (paymentChannel !== false) {
            // transaction has just been processed by acknowledgeTransaction!

            processor.logger().info("PaymentProcessor", __line, '[NEM] [' + trxGateway + '] [TRX] Identified Relevant ' + status + ' Transaction with "' + invoice + '" forwarded to "' + backendSocketId + '"');

            // Payment is relevant - emit back payment status update
            processor.emitPaymentUpdate(forwardToSocket, paymentChannel, status);
        }
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
                          "[NEM] [DROP] Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                self.connectBlockchainSocket();
                return true;
            }

            // uncaught error happened
            self.logger()
                .error("PaymentProcessor", __line, "[NEM] [ERROR] Uncaught Error: " + error);
        };

        // Connect to NEM Blockchain Websocket now
        self.nemsocket_.connectWS(function()
        {
            // on connection we subscribe only to the /errors websocket.
            // PaymentProcessor will open

            self.logger()
                .info("PaymentProcessor", __line,
                      "[NEM] [CONNECT] Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

            // NEM Websocket Error listening
            self.logger().info("PaymentProcessor", __line, '[NEM] [SOCKET] subscribing to /errors.');
            self.nemsocket_.subscribeWS("/errors", function(message)
            {
                self.logger()
                    .info("PaymentProcessor", __line,
                          "[NEM] [ERROR] Error Happened: " + message.body);
            });

            //XXX NEM Websocket new blocks Listener => Should verify confirmations about our payment channels.

            // NEM Websocket unconfirmed transactions Listener
            self.logger().info("PaymentProcessor", __line, '[NEM] [SOCKET] subscribing to /unconfirmed/' + self.blockchain_.getBotReadWallet() + '.');
            self.nemsocket_.subscribeWS("/unconfirmed/" + self.blockchain_.getBotReadWallet(), function(message)
            {
                self.logger().info("PaymentProcessor", __line, '[NEM] [SOCKET] unconfirmed(' + message.body + ')');

                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                self.db_.NEMPaymentChannel.matchTransactionToChannel(self.blockchain_, transactionData, function(paymentChannel)
                    {
                        websocketChannelTransactionHandler(self, paymentChannel, transactionData, "unconfirmed", "SOCKET");
                    });
            });

            // NEM Websocket confirmed transactions Listener
            self.logger().info("PaymentProcessor", __line, '[NEM] [SOCKET] subscribing to /transactions/' + self.blockchain_.getBotReadWallet() + '.');
            self.nemsocket_.subscribeWS("/transactions/" + self.blockchain_.getBotReadWallet(), function(message)
            {
                self.logger().info("PaymentProcessor", __line, '[NEM] [TRX] transactions(' + message.body + ')');

                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;
                var trxHash         = self.getTransactionHash(transactionData);

                self.db_.NEMPaymentChannel.matchTransactionToChannel(self.blockchain_, transactionData, function(paymentChannel)
                    {
                        websocketChannelTransactionHandler(self, paymentChannel, transactionData, "confirmed", "SOCKET");
                    });
            });

        }, websocketErrorHandler);

        return self.nemsocket_;
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
        var self = this;

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
            processor.blockchain_.nem().com.requests.account.incomingTransactions(processor.blockchain_.endpoint(), processor.blockchain_.getBotReadWallet())
                .then(function(res)
            {
                var incomings = res;

                //DEBUG processor.logger().info("PaymentProcessor", __line, "[NEM] [FALLBACK] [TRY] trying to match " + incomings.length + " transactions.");

                for (var i in incomings) {
                    var transaction = incomings[i];
                    var meta    = transaction.meta;
                    var content = transaction.transaction;
                    var trxHash = processor.getTransactionHash(transaction);

                    processor.db_.NEMPaymentChannel.matchTransactionToChannel(processor.blockchain_, transaction, function(paymentChannel)
                        {
                            websocketChannelTransactionHandler(processor, paymentChannel, transaction, "confirmed", "FALLBACK");
                        });
                }
            }, function(err) { processor.logger().error("PaymentProcessor", __line, "[NEM] [FALLBACK] [ERROR] " + err)});
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
    this.emitPaymentUpdate = function(forwardToSocket, paymentChannel, status)
    {
        //XXX implement notifyUrl - webhooks features
        var eventData = paymentChannel.toDict();

        // notify our socket about the update (private communication NEMBot > Backend)
        if (forwardToSocket) {
            forwardToSocket.emit("nembot_payment_status_update", JSON.stringify(eventData));
            this.logger().info("PaymentProcessor", __line, '[' + forwardToSocket.id + '] [BOT] payment_status_update(' + JSON.stringify(eventData) + ')');
        }
        else {
            // no socket OBJECT available - send to socket ID
            //XXX
            forwardToSocket = {id: "UNDEFINED"};
            this.logger().info("PaymentProcessor", __line, '[BOT] Socket not loaded, Payment update not broadcast!');
        }

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
