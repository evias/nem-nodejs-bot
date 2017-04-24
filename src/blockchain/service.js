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

var nemSDK = require("nem-sdk").default,
    nemAPI = require("nem-api");

/**
 * class service provide a business layer for
 * blockchain data queries used in the NEM bot.
 *
 * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
 */
var service = function(config, logger)
{
    // initialize the current running bot's blockchain service with
    // the NEM blockchain. This will create the endpoint for the given
    // network and port (testnet, mainnet, mijin) and will then initialize
    // a common object using the configured private key.
    var nem_  = nemSDK;
    var api_  = nemAPI;
    var conf_ = config;
    var logger_ = logger;

    var isTestMode = config.nem.isTestMode;
    var envSuffix  = isTestMode ? "_TEST" : "";
    var confSuffix = isTestMode ? "_test" : "";

    // connect to the blockchain with the NEM SDK
    var nemHost = process.env["NEM_HOST" + envSuffix] || conf_.nem["nodes" + confSuffix][0].host;
    var nemPort = process.env["NEM_PORT" + envSuffix] || conf_.nem["nodes" + confSuffix][0].port;
    var node_   = nem_.model.objects.create("endpoint")(nemHost, nemPort);

    // following is our bot's XEM wallet address
    var botMode_ = process.env["BOT_MODE"] || conf_.bot.mode;
    var botReadWallet_ = (process.env["BOT_READ_WALLET"] || conf_.bot.read.walletAddress).replace(/-/g, "");
    var botSignWallet_ = (process.env["BOT_SIGN_WALLET"] || conf_.bot.sign.walletAddress).replace(/-/g, "");
    var botTipperWallet_ = (process.env["BOT_TIPPER_WALLET"] || conf_.bot.tipper.walletAddress).replace(/-/g, "");

    // define a helper for development debug of websocket
    this.socketLog = function(msg, type)
    {
        var logMsg = "[" + type + "] " + msg;
        logger_.info("src/blockchain/service.js", __line, logMsg);
    };

    // define a helper for ERROR of websocket
    this.socketError = function(msg, type)
    {
        var logMsg = "[" + type + "] " + msg;
        logger_.error("src/blockchain/service.js", __line, logMsg);
    };

    this.nem = function()
    {
        return nem_;
    };

    this.endpoint = function()
    {
        return node_;
    };

    this.logger = function()
    {
        return logger_;
    };

    this.isMode = function(mode)
    {
        if (typeof conf_.bot.mode == "string")
            return conf_.bot.mode == mode || conf_.bot.mode == "all";

        for (var i in conf_.bot.mode) {
            var current = conf_.bot.mode[i];
            if (mode == current || "all" == current)
                return true;
        }

        return false;
    };

    this.isReadBot = function()
    {
        return this.isMode("read");
    };

    this.isSignBot = function()
    {
        return this.isMode("sign");
    };

    this.isTipperBot = function()
    {
        return this.isMode("tip");
    };

    /**
     * Get this bot's READ Wallet Address
     *
     * This is the address for which the bot will listen to transactions.
     *
     * @return string   XEM account address for the Bot
     */
    this.getBotReadWallet = function()
    {
        return botReadWallet_;
    };

    /**
     * Get this bot's SIGNING Wallet Address
     *
     * This is the wallet used for Co-Signing Multi Signature Transactions,
     * the privateKey must be set for this feature to work.
     *
     * @return string   XEM account address for the Bot
     */
    this.getBotSignWallet = function()
    {
        return botReadWallet_;
    };

    /**
     * Get this bot's TIPPER Wallet Address
     *
     * This is the wallet used for Tipper Bot features,
     * the privateKey must be set for this feature to work.
     *
     * @return string   XEM account address for the Bot
     */
    this.getBotTipperWallet = function()
    {
        return botTipperWallet_;
    };

    /**
     * Get the Network details. This will return the currently
     * used config for the NEM node (endpoint).
     *
     * @return Object
     */
    this.getNetwork = function()
    {
        var isTest  = conf_.nem.isTestMode;
        var isMijin = conf_.nem.isMijin;

        return {
            "host": node_.host,
            "port": node_.port,
            "label": isTest ? "Testnet" : isMijin ? "Mijin" : "Mainnet",
            "config": isTest ? nem_.model.network.data.testnet : isMijin ? nem_.model.network.data.mijin : nem_.model.network.data.mainnet,
            "isTest": isTest,
            "isMijin": isMijin
        };
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
    this.listenForPayment = function(forwardedToSocket, paymentChannel)
    {
        var self = this;
        var backend_   = backendSocket;
        var channel_   = paymentChannel;
        var params_    = params;
        var nemsocket_ = new api_(nemHost + ":" + nemPort);

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

                self.socketLog("NEM Websocket Connection lost, re-connecting..", "DROP");
                self.listenForPayment(backend_, channel_, params_);
                return true;
            }

            // uncaught error happened
            self.socketError("NEM Websocket Uncaught Error: " + error, "UNCAUGHT");
        };

        // define fallback in case websocket does not catch transaction!
        var websocketFallbackHandler = function(paymentChannel)
        {
            self.nem().com.requests.incomingTransactions(self.endpoint(), paymentChannel.recipientXEM)
            .then(function(res)
            {
                var incomings = res;

                for (var i in incomings) {
                    var content = incomings[i].transaction;
                    var meta    = incomings[i].meta;
                    var trxHash = meta.hash.data;
                    if (meta.innerHash.data && meta.innerHash.data.length)
                        trxHash = meta.innerHash.data;

                    var paymentData = {};
                    if (false === (paymentData = paymentChannel.matchTransactionData(content, "confirmed")))
                        continue; // transaction irrelevant for current `paymentChannel`

                    self.emitPaymentUpdate(paymentChannel, transactionData, eventData);
                }
            });
        };

        // fallback handler queries the blockchain every 20 seconds
        setInterval(function()
        {
            // XXX should also check the Block Height and Last Block to know whether there CAN be new data.

            websocketFallbackHandler(paymentChannel);
        }, 30 * 1000);

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

                var paymentData = {};
                if (false === (paymentData = paymentChannel.matchTransactionData(transaction, "unconfirmed")))
                    return false;

                self.emitPaymentUpdate(paymentChannel, transactionData, paymentData, "unconfirmed");
            });

            nemsocket_.subscribeWS("/transactions/" + self.getBotReadWallet(), function(message) {
                var transactionData = JSON.parse(message.body);
                var transaction     = transactionData.transaction;

                var paymentData = {};
                if (false === (paymentData = paymentChannel.matchTransactionData(transaction, "confirmed")))
                    return false;

                self.emitPaymentUpdate(paymentChannel, transactionData, paymentData, "confirmed");
            });

        }, websocketErrorHandler);
    };

    this.emitPaymentUpdate = function(paymentChannel, transactionData, paymentData, status)
    {
        var eventData = paymentData;
        eventData.status = status;

        backend_.emit("nembot_payment_status_update", JSON.stringify(eventData));

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
    }

    var self = this;
    {
        // nothing more done on instanciation
    }
};


module.exports.service = service;
}());
