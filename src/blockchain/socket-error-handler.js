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

    var BlocksAuditor = require("./blocks-auditor.js").BlocksAuditor;

    /**
     * class SocketErrorHandler implements a simple websocket error handler
     * callback that can be used to issue re-connection in case of a dropped
     * connection.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var SocketErrorHandler = function(auditModule) {

        if (!auditModule || typeof auditModule.connectBlockchainSocket == 'undefined') {
            throw "Invalid module provided to SocketErrorHandler class, " +
                "missing implementation for connectBlockchainSocket method.";
        }

        if (typeof auditModule.disconnectBlockchainSocket == 'undefined') {
            throw "Invalid module provided to SocketErrorHandler class, " +
                "missing implementation for disconnectBlockchainSocket method.";
        }

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

        var self = this;

        /**
         * define helper for websocket error handling, the NEM Blockchain Socket
         * should be alive as long as the bot is running so we will always try
         * to reconnect, unless the bot has been stopped from running or has crashed.
         * 
         * @param   {String}    error   The Websocket Error message
         * @return  {Boolean}
         */
        this.handle = function(error) {

            var regexp_LostConn = new RegExp(/Lost connection to/);
            var regexp_ConnRef = new RegExp(/ECONNREFUSED/);
            var regexp_Timeout = new RegExp(/ETIMEOUT/);

            if (regexp_LostConn.test(error)) {
                // connection lost, re-connect

                //XXX count reconnects max 3

                self.logger()
                    .warn("[NEM] [" + self.module_.logLabel + "] [DROP]", __line, "Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                self.module_.connectBlockchainSocket();
                return true;
            } else if (regexp_ConnRef.test(error) || regexp_Timeout.test(error)) {
                // ECONNREFUSED|ETIMEOUT => switch node

                self.logger()
                    .warn("[NEM] [" + self.module_.logLabel + "] [DROP]", __line, "Connection impossible with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now switching.");

                var auditor = self.module_.getAuditor();
                if (!auditor) auditor = new BlockAuditor(self.module_);

                return auditor.autoSwitchSocketNode();
            }

            // uncaught error happened
            self.logger()
                .error("[NEM] [" + self.module_.logLabel + "] [ERROR]", __line, "Uncaught Error: " + error);
        };

        var self = this;
    };

    module.exports.SocketErrorHandler = SocketErrorHandler;
}());