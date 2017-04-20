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

var path = require('path'),
	SecureConf = require("secure-conf"),
    fs = require("fs"),
    pw = require("pw");

var environment = process.env["APP_ENV"] || "development";

// core dependencies
var logger = require('./src/utils/logger.js');
var __smartfilename = path.basename(__filename);

// define a helper to process configuration file encryption
var sconf = new SecureConf();
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

	if (environment == "production")
		// don't delete in development mode
		fs.unlink("config/bot.json");

	return true;
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

				try {
					var server = require("./src/server.js");

					// define a helper to get the blockchain service
					var blockchain = require('./src/blockchain/service.js');
					var chainDataLayer = new blockchain.service(config, logger);

					var bot = new server.NEMBot(config, logger, chainDataLayer);
				}
				catch (e) {
					logger.error(__smartfilename, __line, "Error with NEM Bot Server: " + e);
					logger.warn(__smartfilename, __line, "NEM Bot now aborting.");
				}
			}
			catch (e) {
				logger.error(__smartfilename, __line, "Error with NEM Bot configuration. Invalid encryption password!");
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
