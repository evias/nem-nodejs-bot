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

    /**
     * class BlocksAuditor implements a simple blocks reading Websocket
     * subscription.
     * 
     * This auditor allows our Bot Server to be aware of disconnections
     * and broken Websocket subscriptions (happening without errors..)
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var BlocksAuditor = function(auditModule) {
        this.module_ = auditModule;

        this.blockchain_ = this.module_.blockchain_;
        this.db_ = this.module_.db_;
        this.nemsocket_ = this.module_.nemsocket_;
        this.nemSubscriptions_ = {};

        this.logger = function() {
            return this.blockchain_.logger();
        };

        this.config = function() {
            return this.blockchain_.conf_;
        };

        /**
         * The autoSwitchNode() method will automatically select the 
         * next NEM endpoint Host and Port from the configuration file.
         * 
         * This method is called whenever the websocket connection can't 
         * read blocks or hasn't read blocks in more than 5 minutes.
         * 
         * @return  {BlocksAuditor}
         */
        this.autoSwitchSocketNode = function() {
            var self = this;
            var currentHost = self.blockchain_.node_.host;

            // iterate nodes and connect to first 
            var nodesList = self.blockchain_.conf_.nem["nodes" + self.blockchain_.confSuffix];
            var nextHost = null;
            var nextPort = null;
            do {
                var cntNodes = nodesList.length;
                var randomIdx = Math.floor(Math.random() * (cntNodes - 1));

                nextHost = nodesList[i].host;
                nextPort = nodesList[i].port;
            }
            while (nextHost == currentHost);

            self.logger().warn("[NEM] [" + self.module_.logLabel + "] [AUDIT]", __line, "Socket now switching to Node: " + nextHost + ":" + nextPort + ".");

            // connect to node
            self.blockchain_.node_ = self.blockchain_.nem_.model.objects.create("endpoint")(nextHost, nextPort);
            self.blockchain_.nemHost = nextHost;
            self.blockchain_.nemPort = nextPort;

            // now reconnect sockets
            self.module_.connectBlockchainSocket();
            return self;
        };

        /**
         * Configure the BlocksAuditor websocket connections. This class
         * will connect to following websocket channels:
         * 
         * - /blocks/new
         * 
         * @return  {BlocksAuditor}
         */
        this.subscribeToBlockUpdates = function() {
            var self = this;
            self.nemSubscriptions_ = {};

            try {
                // Listen on ALREADY CONNECTED SOCKET
                self.logger().info("[NEM] [" + self.module_.logLabel + "] [AUDIT]", __line, 'subscribing to /blocks/new.');
                self.nemSubscriptions_["/blocks/new"] = self.nemsocket_.subscribeWS("/blocks/new", function(message) {
                    var parsed = JSON.parse(message.body);
                    self.logger().info("[NEM] [" + self.module_.logLabel + "] [AUDIT]", __line, 'new_block(' + JSON.stringify(parsed) + ')');

                    // check whether this block already exists or save
                    var bkQuery = { moduleName: self.module_.moduleName, blockHeight: parsed.height };
                    self.db_.NEMBlockHeight.findOne(bkQuery, function(err, block) {
                        if (!err && !block) {
                            block = new self.db_.NEMBlockHeight({
                                blockHeight: parsed.height,
                                moduleName: self.module_.moduleName,
                                createdAt: new Date().valueOf()
                            });
                            block.save();
                        }
                    });
                });

            } catch (e) {
                // On Exception, restart connection process
                self.subscribeToBlockUpdates();
            }

            self.registerBlockDelayAuditor();
            return self;
        };

        /**
         * This method should register an interval to run every *10 minutes*
         * which will check the date of the last saved `NEMBlockHeight` entry.
         * If the block entry is older than 5 minutes, the blockchain endpoint
         * will be switched automatically.
         * 
         * After this has been, you will usually need to refresh your Websocket
         * connections as shows the example use case in server.js.
         * 
         * @param   {Function}  callback
         * @return  {BlocksAuditor}
         */
        this.registerBlockDelayAuditor = function(callback) {
            var self = this;

            // add fallback checker for Block Times, if we didn't get a block
            // in more than 5 minutes, change Endpoint.
            var aliveInterval = setInterval(function() {

                // fetch blocks from DB to get the latest time of fetch
                self.db_.NEMBlockHeight.findOne({ moduleName: self.module_ }, null, { sort: { blockHeight: -1 } }, function(err, block) {
                    if (err) {
                        // error happened
                        self.logger().warn("[NEM] [" + self.module_.logLabel + "] [AUDIT] [ERROR]", __line, "DB Read error for NEMBlockHeight: " + err);

                        clearInterval(aliveInterval);
                        self.subscribeToBlockUpdates();
                        return false;
                    }

                    // maximum age is 5 minute old
                    var limitAge = new Date().valueOf() - (5 * 60 * 1000);
                    if (!block || block.createdAt <= limitAge) {
                        // need to switch node.
                        try {
                            self.logger().warn("[NEM] [" + self.module_.logLabel + "] [AUDIT]", __line, "Socket connection lost with node: " + JSON.stringify(self.blockchain_.node_.host) + ".. Now hot-switching Node.");

                            // autoSwitchNode will also re-initialize the Block Auditor
                            clearInterval(aliveInterval);

                            // after connection was established to new node, we should fetch
                            // the last block height to start fresh.
                            self.websocketFallbackHandler();
                            self.autoSwitchSocketNode();
                        } catch (e) {
                            self.logger().error("[NEM] [" + self.module_.logLabel + "] [AUDIT]", __line, "Socket connection lost with Error: " + e);
                        }
                    }

                    return false;
                });
            }, 10 * 60 * 1000);

            // first time use HTTP fallback to have latest block when starting
            self.websocketFallbackHandler();
            return self;
        };

        /**
         * This method uses the SDK to fetch the latest block height
         * from the NEM blockchain Node configured in `this.blockchain_`.
         * 
         * @return void
         */
        this.websocketFallbackHandler = function() {
            var self = this;

            // fetch the latest block height and save in database
            self.blockchain_.nem()
                .com.requests.chain.height(self.blockchain_.endpoint())
                .then(function(res) {

                    self.logger().info("[NEM] [" + self.module_.logLabel + "] [AUDIT-FALLBACK]", __line, 'new_block(' + JSON.stringify(res) + ')');

                    // check whether this block already exists or save
                    var bkQuery = { moduleName: self.module_.moduleName, blockHeight: res.height };
                    self.db_.NEMBlockHeight.findOne(bkQuery, function(err, block) {
                        if (!err && !block) {
                            block = new self.db_.NEMBlockHeight({
                                blockHeight: res.height,
                                moduleName: self.module_.moduleName,
                                createdAt: new Date().valueOf()
                            });
                            block.save();
                        }
                    });
                });
        };

        var self = this; {
            // when the BlocksAuditor is instantiated it should start
            // auditing for blocks right a way.

            self.subscribeToBlockUpdates();
        }
    };

    module.exports.BlocksAuditor = BlocksAuditor;
}());