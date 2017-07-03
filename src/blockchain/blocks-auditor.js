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
     * class BlocksAuditor implements a simple blocks reading Websocket
     * subscription.
     * 
     * This auditor allows our Bot Server to be aware of disconnections
     * and broken Websocket subscriptions (happening without errors..)
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var BlocksAuditor = function(chainDataLayer) {
        var api_ = nemAPI;

        this.blockchain_ = chainDataLayer;
        this.db_ = this.blockchain_.getDatabaseAdapter();

        this.nemsocket_ = new api_(this.blockchain_.nemHost + ":" + this.blockchain_.nemPort);
        this.nemConnection_ = null;
        this.nemSubscriptions_ = {};

        this.logger = function() {
            return this.blockchain_.logger();
        };

        this.config = function() {
            return this.blockchain_.conf_;
        };

        /**
         * Open the connection to a Websocket to the NEM Blockchain endpoint configured
         * through ```this.blockchain_```.
         *
         * @return {[type]} [description]
         */
        this.connectBlockchainSocket = function() {
            var self = this;

            // define helper for websocket error handling, the NEM Blockchain Socket
            // should be alive as long as the bot is running so we will always try
            // to reconnect, unless the bot has been stopped from running or has crashed.
            var websocketErrorHandler = function(error) {
                var regexp_LostConn = new RegExp(/Lost connection to/);
                if (regexp_LostConn.test(error)) {
                    // connection lost, re-connect

                    self.logger()
                        .warn("[NEM] [DROP]", __line,
                            "Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                    self.connectBlockchainSocket();
                    return true;
                }
                //XXX ECONNREFUSED => switch node

                // uncaught error happened
                self.logger()
                    .error("[NEM] [ERROR]", __line, "Uncaught Error: " + error);
            };

            // Connect to NEM Blockchain Websocket now
            self.nemConnection_ = self.nemsocket_.connectWS(function() {
                // on connection we subscribe only to the /errors websocket.
                // BlocksAuditor will open

                self.logger()
                    .info("[NEM] [CONNECT]", __line,
                        "Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

                // NEM Websocket Error listening
                self.logger().info("[NEM] [AUDIT-SOCKET]", __line, 'subscribing to /errors.');
                self.nemSubscriptions_["/errors"] = self.nemsocket_.subscribeWS("/errors", function(message) {
                    self.logger()
                        .error("[NEM] [ERROR] [AUDIT-SOCKET]", __line,
                            "Error Happened: " + message.body);
                });

                // NEM Websocket new blocks Listener
                self.nemSubscriptions_["/blocks/new"] = self.nemsocket_.subscribeWS("/blocks/new", function(message) {
                    var parsed = JSON.parse(message.body);
                    self.logger().info("[NEM] [AUDIT-SOCKET]", __line, 'new_block(' + JSON.stringify(parsed) + ')');

                    var block = new self.db_.NEMBlockHeight({
                        blockHeight: parsed.height,
                        createdAt: new Date().valueOf()
                    });
                    block.save();
                });

            }, websocketErrorHandler);

            return self;
        };

        this.registerBlockDelayAuditor = function(callback) {
            var self = this;

            // add fallback checker for Block Times, if we didn't get a block
            // in more than 5 minutes, change Endpoint.
            var aliveInterval = setInterval(function() {

                // fetch blocks from DB to get the latest time of fetch
                self.db_.NEMBlockHeight.findOne({}, null, { sort: { blockHeight: -1 } }, function(err, block) {
                    // maximum age is 5 minute old
                    var limitAge = new Date().valueOf() - (5 * 60 * 1000);
                    if (block.createdAt <= limitAge) {
                        // need to switch node.
                        self.logger().warn("[NEM] [AUDIT-SOCKET]", __line, "Socket connection lost with node: " + JSON.stringify(self.blockchain_.node_.host) + ".. Now hot-switching Node.");
                        self.blockchain_.autoSwitchNode();

                        if (callback) return callback(self);
                    }

                    return false;
                });
            }, 10 * 60 * 1000);

            return self;
        };

        var self = this; {
            // nothing more done on instanciation
        }
    };


    module.exports.BlocksAuditor = BlocksAuditor;
}());