var ethJSABI = require("ethjs-abi");
var Web3 = require("./web3.js");

var BigNumber = (new Web3()).toBigNumber(0).constructor;

var Utils = {
  is_object: function(val) {
    return typeof val == "object" && !Array.isArray(val);
  },
  is_big_number: function(val) {
    if (typeof val != "object") return false;

    // Instanceof won't work because we have multiple versions of Web3.
    try {
      new BigNumber(val);
      return true;
    } catch (e) {
      return false;
    }
  },
  decodeLogs: function(C, instance, logs) {
    return logs.map(function(log) {
      var logABI = C.events[log.topics[0]];

      if (logABI == null) {
        return null;
      }

      // This function has been adapted from web3's SolidityEvent.decode() method,
      // and built to work with ethjs-abi.

      var copy = Utils.merge({}, log);

      function partialABI(fullABI, indexed) {
        var inputs = fullABI.inputs.filter(function (i) {
          return i.indexed === indexed;
        });

        var partial = {
          inputs: inputs,
          name: fullABI.name,
          type: fullABI.type,
          anonymous: fullABI.anonymous
        };

        return partial;
      }

      var argTopics = logABI.anonymous ? copy.topics : copy.topics.slice(1);
      var indexedData = "0x" + argTopics.map(function (topics) { return topics.slice(2); }).join("");
      var indexedParams = ethJSABI.decodeEvent(partialABI(logABI, true), indexedData);

      var notIndexedData = copy.data;
      var notIndexedParams = ethJSABI.decodeEvent(partialABI(logABI, false), notIndexedData);

      copy.event = logABI.name;

      copy.args = logABI.inputs.reduce(function (acc, current) {
        var val = indexedParams[current.name];

        if (val === undefined) {
          val = notIndexedParams[current.name];
        }

        acc[current.name] = val;
        return acc;
      }, {});

      Object.keys(copy.args).forEach(function(key) {
        var val = copy.args[key];

        // We have BN. Convert it to BigNumber
        if (val.constructor.isBN) {
          copy.args[key] = C.web3.toBigNumber("0x" + val.toString(16));
        }
      });

      delete copy.data;
      delete copy.topics;

      return copy;
    }).filter(function(log) {
      return log != null;
    });
  },
  promisifyFunction: function(fn, C) {
    var self = this;
    return function() {
      var instance = this;

      var args = Array.prototype.slice.call(arguments);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(C.class_defaults, tx_params);

      return C.detectNetwork().then(function() {
        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      });
    };
  },
  synchronizeFunction: function(fn, instance, C) {
    var self = this;
    return function() {
      var args = Array.prototype.slice.call(arguments);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(C.class_defaults, tx_params);

      return C.detectNetwork().then(function() {
        return new Promise(function(accept, reject) {
          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  return accept({
                    tx: tx,
                    receipt: receipt,
                    logs: Utils.decodeLogs(C, instance, receipt.logs)
                  });
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      });
    };
  },
  merge: function() {
    var merged = {};
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < args.length; i++) {
      var object = args[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        merged[key] = value;
      }
    }

    return merged;
  },
  parallel: function (arr, callback) {
    callback = callback || function () {};
    if (!arr.length) {
      return callback(null, []);
    }
    var index = 0;
    var results = new Array(arr.length);
    arr.forEach(function (fn, position) {
      fn(function (err, result) {
        if (err) {
          callback(err);
          callback = function () {};
        } else {
          index++;
          results[position] = result;
          if (index >= arr.length) {
            callback(null, results);
          }
        }
      });
    });
  },
  bootstrap: function(fn) {
    // Add our static methods
    Object.keys(fn._static_methods).forEach(function(key) {
      fn[key] = fn._static_methods[key].bind(fn);
    });

    // Add our properties.
    Object.keys(fn._properties).forEach(function(key) {
      fn.addProp(key, fn._properties[key]);
    });

    return fn;
  },
  linkBytecode: function(bytecode, links) {
    Object.keys(links).forEach(function(library_name) {
      var library_address = links[library_name];
      var regex = new RegExp("__" + library_name + "_+", "g");

      bytecode = bytecode.replace(regex, library_address.replace("0x", ""));
    });

    return bytecode;
  }
};

module.exports = Utils;