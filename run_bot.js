#!/usr/bin/nodejs
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
 * @author     Grégory Saive <greg@evias.be>
 * @license    MIT License
 * @copyright  (c) 2017, Grégory Saive <greg@evias.be>
 * @link       http://github.com/evias/nem-nodejs-bot
 */

var app = require('express')(),
	server = require('http').createServer(app),
	path = require('path'),
	auth = require("http-auth"),
	bodyParser = require("body-parser"),
	config = require("secure-conf"),
    fs = require("fs");

// core dependencies
var logger = require('./src/utils/logger.js');
var __smartfilename = path.basename(__filename);

var serverLog = function(req, msg, type)
{
	var logMsg = "[" + type + "] " + msg + " (" + (req.headers ? req.headers['x-forwarded-for'] : "?") + " - "
			   + (req.connection ? req.connection.remoteAddress : "?") + " - "
			   + (req.socket ? req.socket.remoteAddress : "?") + " - "
			   + (req.connection && req.connection.socket ? req.connection.socket.remoteAddress : "?") + ")";
	logger.info(__smartfilename, __line, logMsg);
};

// define a helper to get the blockchain service
var chainDataLayers = {};
var getChainService = function(config)
{
	var thisBot = config.bot.walletAddress;
	if (! chainDataLayers.hasOwnProperty(thisBot)) {
		var blockchain = require('./src/blockchain/service.js');

		chainDataLayers[thisBot] = new blockchain.service(config);
	}

	return chainDataLayers[thisBot];
};

/**
 * Delayed route configuration. This will only be triggered when
 * the configuration file can be decrypted.
 *
 * Following is where we set our Bot's API endpoints. The API
 * routes list will change according to the Bot's "mode" config
 * value.
 */
var serveAPI = function(config)
{
	// configure body-parser usage for POST API calls.
	app.use(bodyParser.urlencoded({ extended: true }));

	/**
	 * API Routes
	 *
	 * Following routes are used for handling the business/data
	 * layer provided by this NEM Bot.
	 */
	app.get("/api/v1/ping", function(req, res)
		{
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({item: {pong: new Date().valueOf()}}));
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
var startBotServer = function(config)
{
	/**
	 * Now listen for connections on the Web Server.
	 *
	 * This starts the NodeJS server and makes the Game
	 * available from the Browser.
	 */
	var port = process.env['PORT'] = process.env.PORT || 29081;
	server.listen(port, function()
		{
			var network    = getChainService(config).getNetwork();
			var blockchain = network.isTest ? "Testnet Blockchain" : network.isMijin ? "Mijin Private Blockchain" : "NEM Mainnet Public Blockchain";
			var botWallet  = getChainService(config).getBotWallet();

			console.log("------------------------------------------------------------------------");
			console.log("--                       NEM Bot by eVias                             --");
			console.log("------------------------------------------------------------------------");
			console.log("-");
			console.log("- NEM Bot Server listening on Port %d in %s mode", this.address().port, app.settings.env);
			console.log("- NEM Bot is using blockchain: " + blockchain);
			console.log("- NEM Bot Wallet is: " + botWallet);
			console.log("-")
			console.log("------------------------------------------------------------------------");
		});
};

/**
 * This Bot will only start serving its API when the configuration
 * file is encrypted and can be decrypted.
 *
 * In case the configuration file is not encrypted yet, it will be encrypted
 * and the original file will be deleted.
 */
var sconf = new SecureConf();

// check whether the encrypted file must be created.
if (! fs.existsSync("config/bot.json.enc")) {
	// need to encrypt content and delete the plaintext config
	// before we can start the bot.

	sconf.encryptFile(
		"config/bot.json",
		"config/bot.json.enc",
		process.env["ENCRYPT_PASS"],
		function(err, file, encF, encC)
			{
				if (err) {
					// WILL NOT SERVE THE BOT
					logger.error(__smartfilename, __line, "Could not decrypt configuration file config/bot.json.enc");
					logger.warn(__smartfilename, __line, "NEM Bot aborted!");
					return false;
				}

				if (app.settings.env == "production")
					fs.unlink("config/bot.json");
			});
}

// now decrypt content if possible and run the bot.
sconf.decryptFile(
	"config/bot.json.enc",
	process.env["ENCRYPT_PASS"],
	function(err, file, content)
	{
		var config = JSON.parse(content);
		serveAPI(config);
		startBotServer(config);
	});
