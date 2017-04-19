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

var nemSDK = require("nem-sdk").default;

/**
 * class service provide a business layer for
 * blockchain data queries used in the NEM bot.
 *
 * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
 */
var service = function(config)
{
    // initialize the current running bot's blockchain service with
    // the NEM blockchain. This will create the endpoint for the given
    // network and port (testnet, mainnet, mijin) and will then initialize
    // a common object using the configured private key.
    var nem_  = nemSDK;
    var conf_ = config;

    var isTestMode = config.nem.isTestMode;
    var envSuffix  = isTestMode ? "_TEST" : "";
    var confSuffix = isTestMode ? "_test" : "";

    // connect to the blockchain with the NEM SDK
    var nemHost = process.env["NEM_HOST" + envSuffix] || conf_.nem["nodes" + confSuffix][0].host;
    var nemPort = process.env["NEM_PORT" + envSuffix] || conf_.nem["nodes" + confSuffix][0].port;
    var node_   = nem_.model.objects.create("endpoint")(nemHost, nemPort);

    // following is our bot's XEM wallet address
    var botWallet_  = (process.env["BOT_WALLET"] || conf_.bot.walletAddress).replace(/-/g, "");

    /**
     * Get this bot's Wallet Address
     *
     * @return string   XEM account address for the Bot
     */
    this.getBotWallet = function()
    {
        return botWallet_;
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
     * Get the status of the currently select NEM blockchain node.
     *
     * @return Promise
     */
    this.heartbeat = function()
    {
        return nem_.com.requests.endpoint.heartbeat(node_);
    };
};


module.exports.service = service;
}());
