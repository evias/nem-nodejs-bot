/**
 * Part of the evias/pacNEM package.
 *
 * NOTICE OF LICENSE
 *
 * Licensed under MIT License.
 *
 * This source file is subject to the MIT License that is
 * bundled with this package in the LICENSE file.
 *
 * @package    evias/pacNEM
 * @author     Grégory Saive <greg@evias.be> (https://github.com/evias)
 * @contributor Nicolas Dubien (https://github.com/dubzzz)
 * @license    MIT License
 * @copyright  (c) 2017, Grégory Saive <greg@evias.be>
 * @link       https://github.com/evias/pacNEM
 * @link       https://github.com/dubzzz/js-pacman
 */

// Add ability to access line number
// http://stackoverflow.com/questions/11386492/accessing-line-number-in-v8-javascript-chrome-node-js
Object.defineProperty(global, '__stack', {
	get: function(){
		var orig = Error.prepareStackTrace;
		Error.prepareStackTrace = function(_, stack){ return stack; };
		var err = new Error;
		Error.captureStackTrace(err, arguments.callee);
		var stack = err.stack;
		Error.prepareStackTrace = orig;
		return stack;
	}
});
Object.defineProperty(global, '__line', {
	get: function(){
		return __stack[1].getLineNumber();
	}
});

(function() {

var log = function(tag, filename, line, description) {
	var d = new Date();
	console.log(
			'[' + String(d).substr(0,15) + ' ' + d.toLocaleTimeString() + ']\t'
			+ tag + '\t' + filename + '\t:' + line + '\t' + description);
};

var debug = function(filename, line, description) {
	log("\u001b[36mDEBUG\u001b[0m", filename, line, description);
};
var info = function(filename, line, description) {
	log("\u001b[32mINFO\u001b[0m", filename, line, description);
};
var warn = function(filename, line, description) {
	log("\u001b[33mWARN", filename, line, description + "\u001b[0m");
};
var error = function(filename, line, description) {
	log("\u001b[31mERROR", filename, line, description + "\u001b[0m");
};

module.exports.debug = debug;
module.exports.info = info;
module.exports.warn = warn;
module.exports.error = error;
}());

