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
	SecureConf = require("secure-conf"),
    fs = require("fs"),
    pw = require("pw");

// core dependencies
var logger = require('./src/utils/logger.js');
var __smartfilename = path.basename(__filename);

// define a helper for development debug of requests
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

// define a helper to process configuration file encryption
var encryptConfig = function(pass)
{
	var dec = fs.readFileSync("config/bot.json");
	var enc = sconf.encryptContent(dec, pass);

	if (enc === undefined) {
		logger.error(__smartfilename, __line, "Configuration file config/bot.json could not be encrypted.");
		logger.warn(__smartfilename, __line, "NEM Bot now aborting.");
		return false;
	}

	fs.writeFileSync("config/bot.json.enc", enc);

	if (app.settings.env == "production")
		// don't delete in development mode
		fs.unlink("config/bot.json");

	return true;
};

/**
 * Delayed route configuration. This will only be triggered when
 * the configuration file can be decrypted.
 *
 * Following is where we set our Bot's API endpoints. The API
 * routes list will change according to the Bot's "mode" config
 * value.
 */
var initBotAPI = function(config)
{
	// configure body-parser usage for POST API calls.
	app.use(bodyParser.urlencoded({ extended: true }));

	if (config.bot.protectedEndpoints === true) {
		// add Basic HTTP auth using nem-bot.htpasswd file

		var basicAuth = auth.basic({
		    realm: "This is a Highly Secured Area - Monkey at Work.",
		    file: __dirname + "/nem-bot.htpasswd"
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
var initBotServer = function(config)
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
 * Delayed Bot execution. This function STARTS the bot and will only
 * work in case the encrypted configuration file exists AND can be
 * decrypted with the provided password (or asks password in console.)
 *
 * On heroku, as it is not possible to enter data in the console, the password
 * must be set in the ENCRYPT_PASS "Config Variable" of your Heroku app which
 * you can set under the "Settings" tab.
 */
var startBot = function(pass)
{
	if (fs.existsSync("config/bot.json.enc")) {
		// Only start the bot in case the file is found
		// and can be decrypted.

		var enc = fs.readFileSync("config/bot.json.enc", {encoding: "utf8"});
		var dec = sconf.decryptContent(enc, pass);

		if (dec === undefined) {
			logger.error(__smartfilename, __line, "Configuration file config/bot.json could not be decrypted.");
			logger.warn(__smartfilename, __line, "NEM Bot now aborting.");
		}
		else {
			try {
				var config = JSON.parse(dec);
				initBotAPI(config);
				initBotServer(config);
			}
			catch (e) {
				logger.error(__smartfilename, __line, "Error with NEM Bot configuration: " + e);
				logger.warn(__smartfilename, __line, "NEM Bot now aborting.");
			}
		}
	}
};

/**
 * This Bot will only start serving its API when the configuration
 * file is encrypted and can be decrypted.
 *
 * In case the configuration file is not encrypted yet, it will be encrypted
 * and the original file will be deleted.
 */
var sconf = new SecureConf();
var pass  = process.env["ENCRYPT_PASS"] || "";

if (typeof pass == 'undefined' || ! pass.length) {
	// get enc-/dec-rypt password from console

	if (! fs.existsSync("config/bot.json.enc")) {
		// encrypted configuration file not yet created

		console.log("Please enter a password for Encryption: ");
		pw(function(password) {
			encryptConfig(password);
			startBot(password);
		});
	}
	else {
		// encrypted file exists, ask password for decryption

		console.log("Please enter your password: ");
		pw(function(password) {
			startBot(password);
		});
	}
}
else {
	// use environment variable password

	if (! fs.existsSync("config/bot.json.enc"))
		// encrypted file must be created
		encryptConfig(pass);

	startBot(pass);
}
