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

var app = require('express')(),
    server = require('http').createServer(app),
    auth = require("http-auth"),
    bodyParser = require("body-parser"),
    fs = require("fs"),
    io = require('socket.io').listen(server);

// configure database layer
var models = require('./db/models.js');

var NEMBot = function(config, logger, chainDataLayer)
{
    this.config_      = config;
    this.blockchain_  = chainDataLayer;
    this.environment_ = process.env["APP_ENV"] || "development";

    this.db        = new models.NEMBotDB(config, io, chainDataLayer);
    this.channels_ = {};

    // define a helper for development debug of requests
    this.serverLog = function(req, msg, type)
    {
        var logMsg = "[" + type + "] " + msg + " (" + (req.headers ? req.headers['x-forwarded-for'] : "?") + " - "
                   + (req.connection ? req.connection.remoteAddress : "?") + " - "
                   + (req.socket ? req.socket.remoteAddress : "?") + " - "
                   + (req.connection && req.connection.socket ? req.connection.socket.remoteAddress : "?") + ")";
        logger.info("src/server.js", __line, logMsg);
    };

    /**
     * Delayed route configuration. This will only be triggered when
     * the configuration file can be decrypted.
     *
     * Following is where we set our Bot's API endpoints. The API
     * routes list will change according to the Bot's "mode" config
     * value.
     */
    this.initBotAPI = function(config)
    {
        var self = this;

        // configure body-parser usage for POST API calls.
        app.use(bodyParser.urlencoded({ extended: true }));

        if (config.bot.protectedAPI === true) {
            // add Basic HTTP auth using nem-bot.htpasswd file

            var basicAuth = auth.basic({
                realm: "This is a Highly Secured Area - Monkey at Work.",
                file: __dirname + "/../nem-bot.htpasswd"
            });
            app.use(auth.connect(basicAuth));
        }

        var package = fs.readFileSync("package.json");
        var botPackage = JSON.parse(package);

        /**
         * API Routes
         *
         * Following routes are used for handling the business/data
         * layer provided by this NEM Bot.
         */
        app.get("/api/v1/ping", function(req, res)
            {
                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify({time: new Date().valueOf()}));
            });

        app.get("/api/v1/version", function(req, res)
            {
                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify({version: botPackage.version}));
            });

        if (self.blockchain_.isReadBot()) {
            // This NEMBot has "read" mode enabled, which means it may be
            // listening to payment channels configured from your backend.

            app.get("/api/v1/channels", function(req, res)
                {
                    res.setHeader('Content-Type', 'application/json');

                    self.db.NEMPaymentChannel.find({}, function(err, channels)
                    {
                        if (err) return res.send(JSON.stringify({"status": "error", "message": err}));

                        var responseData = {};
                        responseData.status = "ok";
                        responseData.data = channels;

                        return res.send(JSON.stringify(responseData));
                    });
                });

            //XXX will be removed or secured
            app.get("/api/v1/reset", function(req, res)
                {
                    res.setHeader('Content-Type', 'application/json');

                    self.db.NEMPaymentChannel.remove({});
                });
        }
    };

    /**
     * Delayed Server listener configuration. This will only be triggered when
     * the configuration file can be decrypted.
     *
     * Following is where we Start the express Server and where the routes will
     * be registered.
     */
    this.initBotServer = function(config)
    {
        var self = this;

        /**
         * Now listen for connections on the Web Server.
         *
         * This starts the NodeJS server and makes the Game
         * available from the Browser.
         */
        var port = process.env['PORT'] = process.env.PORT || 29081;
        server.listen(port, function()
            {
                var network    = self.blockchain_.getNetwork();
                var blockchain = network.isTest ? "Testnet Blockchain" : network.isMijin ? "Mijin Private Blockchain" : "NEM Mainnet Public Blockchain";
                var botReadWallet = self.blockchain_.getBotReadWallet();
                var botSignWallet = self.blockchain_.getBotSignWallet();
                var botTipperWallet = self.blockchain_.getBotTipperWallet();
                var currentBotMode= self.config_.bot.mode;
                var botLabel = self.config_.bot.name;

                var features = {
                    "read": [
                        "Payment Channel Listening",
                        "Balance Modifications Listening",
                        "Cosignatory Auditing"
                    ],
                    "sign": ["Multi Signature Transaction Co-Signing"],
                    "tip": ["Tipper Bot"]
                };

                var allFeatures = features.read.concat(features.sign).concat(features.tip);

                if (typeof currentBotMode == "string")
                    var botFeatures = features.hasOwnProperty(currentBotMode) ? features[currentBotMode] : allFeatures;
                else {
                    var botFeatures = [];
                    for (var j in currentBotMode) {
                        var mode = currentBotMode[j];
                        botFeatures.concat(features[mode]);
                    }
                }

                var grnFeature  = "\t\u001b[32mYES\u001b[0m\t";
                var redFeature  = "\t\u001b[31mNO\u001b[0m\t";

                console.log("------------------------------------------------------------------------");
                console.log("--                       NEM Bot by eVias                             --");
                console.log("------------------------------------------------------------------------");
                console.log("-");
                console.log("- NEM Bot Server listening on Port %d in %s mode", this.address().port, self.environment_);
                console.log("- NEM Bot is using blockchain: " + blockchain);
                console.log("- NEM Bot Listens to Wallet: " + botReadWallet);
                console.log("- NEM Bot Co-Signs with Wallet: " + botSignWallet);
                console.log("- NEM Bot Tips with Wallet: " + botTipperWallet);
                console.log("-");
                console.log("- NEMBot Name is " + botLabel + " with Features: ");

                for (var i in features.read)
                    console.log ((self.blockchain_.isReadBot() ? grnFeature : redFeature) + features.read[i]);

                for (var i in features.sign)
                    console.log ((self.blockchain_.isSignBot() ? grnFeature : redFeature) + features.sign[i]);

                for (var i in features.tip)
                    console.log ((self.blockchain_.isTipperBot() ? grnFeature : redFeature) + features.tip[i]);

                console.log("-");
                console.log("------------------------------------------------------------------------");
            });
    };

    /**
     * This will initialize listening on socket.io websocket
     * channels. This method is used to Protect the Bot and not
     * disclose the bot location (url, IP,..) while using it
     * from a Node.js app.
     *
     * Your Node.js app's BACKEND should subscribe to this websocket
     * stream, NOT YOUR FRONTEND!
     *
     * @param  {[type]} config [description]
     * @return {[type]}        [description]
     */
    this.initSocketProxy = function(config)
    {
        var self = this,
            backends_connected_ = {};

        io.sockets.on('connection', function(socket)
        {
            logger.info("src/server.js", __line, '[' + socket.id + '] nembot()');
            backends_connected_[socket.id] = socket;

            if (self.blockchain_.isReadBot()) {
                self.configurePaymentChannelWebsockets(socket);
            }

            socket.on('nembot_disconnect', function () {
                logger.info("src/server.js", __line, '[' + socket.id + '] ~nembot()');

                if (backends_connected_.hasOwnProperty(socket.id))
                    delete backends_connected_[socket.id];
            });
        });
    };

    this.configurePaymentChannelWebsockets = function(botSocket)
    {
        var self = this;

        // When a payment channel is opened, we must initialize the nem websockets
        // listening to our Bot's accounts channels (/unconfirmed and /transactions for now)
        botSocket.on('nembot_open_payment_channel', function (channelOpts)
        {
            //XXX validate input .sender, .recipient, .message, .amount

            logger.info("src/server.js", __line, '[' + botSocket.id + '] open_channel(' + channelOpts + ')');

            var params = JSON.parse(channelOpts);

            var channelQuery = {
                "payerXEM": params.sender,
                "recipientXEM": params.recipient,
                "message": params.message
            };

            self.db.NEMPaymentChannel.findOne(channelQuery, function(err, paymentChannel)
            {
                if (! err && paymentChannel) {
                    // channel exists - not fulfilled
                    self.blockchain_.listenForPayment(botSocket, paymentChannel, {duration: params.maxDuration});
                }
                else if (! err) {
                    // create new channel
                    var paymentChannel = new self.db.NEMPaymentChannel({
                        recipientXEM: params.recipient,
                        payerXEM: params.sender,
                        message: params.message,
                        amount: params.amount,
                        amountPaid: 0,
                        amountUnconfirmed: 0,
                        status: "created",
                        isPaid: false,
                        createdAt: new Date().valueOf()
                    });

                    paymentChannel.save(function(err, paymentChannel)
                    {
                        self.blockchain_.listenForPayment(botSocket, paymentChannel, {duration: params.maxDuration});
                    });
                }
                else {
                    logger.error("src/server.js", __line, "NEMPaymentChannel model Error: " + err);
                }
            });
        });
    };

    var self = this;
    {
        // new instances automatically init the server and endpoints
        self.initBotDatabase(self.config_);
        self.initBotAPI(self.config_);
        self.initSocketProxy(self.config_);
        self.initBotServer(self.config_);
    }
};

module.exports.NEMBot = NEMBot;
}());