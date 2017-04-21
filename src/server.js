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
    io = require('socket.io').listen(server),
    JsonDB = require("node-json-db");

var NEMBot = function(config, logger, chainDataLayer)
{
    this.config_      = config;
    this.blockchain_  = chainDataLayer;
    this.environment_ = process.env["APP_ENV"] || "development";

    this.db        = null;
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

    this.initBotDatabase = function(config)
    {
        this.db = new JsonDB(config.bot.db.name); //XXX read bot.db.type to know which DBMS to use.

        //this.db.delete("/channels");
        try {
            this.channels_ = this.db.getData("/channels");
        }
        catch (e) {
            // create databases
            this.db.push("/channels", {created: true, "open": {}, "active": {}});
            this.db.push("/archives", {created: true});
        }
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

        app.get("/api/v1/channels/:pool?", function(req, res)
            {
                res.setHeader('Content-Type', 'application/json');

                var channelPool = typeof req.params.pool != 'undefined' && req.params.pool.length ? req.params.pool : "";
                var validPools  = {"open": 0, "active": 1};
                if (channelPool.length && ! validPools.hasOwnProperty(channelPool)) {
                    return res.send(JSON.stringify({"status": "error", "message": "Invalid payment channel pool provided."}));
                }

                var responseData = {};
                try {

                    var query = "/channels";
                    if (channelPool.length)
                        query = query + "/" + channelPool;

                    var channels = self.db.getData(query);
                    responseData.data  = channels;
                }
                catch(e) {
                    responseData.data = {};
                }

                return res.send(JSON.stringify(responseData));
            });

        app.get("/api/v1/reset-channels", function(req, res)
            {
                res.setHeader('Content-Type', 'application/json');

                self.db.delete("/channels");
                res.send(JSON.stringify({status: "ok"}));
            });

        //XXX read config and serve given API endpoints.
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
                var botWallet  = self.blockchain_.getBotWallet();

                console.log("------------------------------------------------------------------------");
                console.log("--                       NEM Bot by eVias                             --");
                console.log("------------------------------------------------------------------------");
                console.log("-");
                console.log("- NEM Bot Server listening on Port %d in %s mode", this.address().port, self.environment_);
                console.log("- NEM Bot is using blockchain: " + blockchain);
                console.log("- NEM Bot Wallet is: " + botWallet);
                console.log("-")
                console.log("------------------------------------------------------------------------");
            });
    };

    /**
     * This will initialize listening on socket.io websocket
     * channels. This method is used to Protected the Bot and not
     * disclose the bot identity (or url, IP,..) while using it
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
        var self = this;

        var backends_connected_ = {},
            payment_channels_   = {};

        io.sockets.on('connection', function(socket)
        {
            logger.info("src/server.js", __line, '[' + socket.id + '] nembot()');
            backends_connected_[socket.id] = socket;

            // When a payment channel is opened, we must initialize the nem websockets
            // listening to our Bot's accounts channels (/unconfirmed and /transactions for now)
            socket.on('nembot_open_payment_channel', function (channelOpts) {
                logger.info("src/server.js", __line, '[' + socket.id + '] open_channel(' + channelOpts + ')');

                var options = JSON.parse(channelOpts);

                try {
                    // find an ACTIVE payment channel with the same SENDER.
                    // This would mean an OPEN INVOICE.
                    try {
                        // check if maybe the channel was not closed, re-use.
                        var channel = self.db.getData("/channels/open/" + options.sender);
                    }
                    catch (e) {
                        // check if any active channel is available for this sender.
                        var channel = self.db.getData("/channels/active/" + options.sender);
                        self.db.push("/channels/open", channel, false); // dont override, merge!
                    }
                }
                catch (e) {
                    // channel does not exist yet, create now.

                    var emptyChannel = {};
                    emptyChannel[options.sender] = options;

                    self.db.push("/channels/open", emptyChannel, false); // dont override, merge!
                    self.db.push("/channels/active", emptyChannel, false); // dont override, merge!

                    var channel = {};
                }

                // configure blockchain service WebSockets
                var paymentChannel = payment_channels_[socket.id]
                                   = self.blockchain_.openPaymentChannel(socket, options, channel);
            });

            socket.on('nembot_close_payment_channel', function (sender) {
                logger.info("src/server.js", __line, '[' + socket.id + '] close_channel(' + sender + ')');

                // delete this payment channel from the OPEN list (might still be /active)
                self.db.delete("/channels/open/" + sender);

                if (payment_channels[socket.id]) {
                    delete payment_channels_[socket.id];
                }
            });

            socket.on('nembot_finish_payment_channel', function (sender) {
                logger.info("src/server.js", __line, '[' + socket.id + '] finish_channel(' + sender + ')');

                // delete this payment channel from the ACTIVE list (might still be /active)
                self.db.delete("/channels/open/" + sender);
                self.db.delete("/channels/active/" + sender);

                if (payment_channels[socket.id]) {
                    delete payment_channels_[socket.id];
                }
            });

            // payment status update must update our channels db
            socket.on('nembot_payment_status_update', function (updateData) {
                var options = JSON.parse(updateData);

                self.db.push("/channels/open/" + options.sender, options, false);
                self.db.push("/channels/active/" + options.sender, options, false);
            });

            socket.on('nembot_disconnect', function () {
                logger.info("src/server.js", __line, '[' + socket.id + '] ~nembot()');

                // delete this payment channel from the OPEN list (might still be /active)
                self.db.delete("/channels/open/" + sender);

                if (backends_connected_.hasOwnProperty(socket.id))
                    delete backends_connected_[socket.id];
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