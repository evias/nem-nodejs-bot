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
    fs = require("fs");

var NEMBot = function(config, chainDataLayer)
{
    this.config_      = config;
    this.blockchain_  = chainDataLayer;
    this.environment_ = process.env["APP_ENV"] || "development";

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
        // configure body-parser usage for POST API calls.
        app.use(bodyParser.urlencoded({ extended: true }));

        if (config.bot.protectedEndpoints === true) {
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

    var self = this;
    {
        // new instances automatically init the server and endpoints
        self.initBotAPI(self.config_);
        self.initBotServer(self.config_);
    }
};

module.exports.NEMBot = NEMBot;
}());