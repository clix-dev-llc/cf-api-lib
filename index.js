"use strict";

var error = require("./error");
var fs = require("fs");
var mime = require("mime");
var Util = require("./util");
var Url = require("url");

var Client = module.exports = function(config) {
    config.headers = config.headers || {};
    this.config = config;
    this.debug = Util.isTrue(config.debug);

    this.version = config.version;
    var cls = require("./api/v" + this.version);
    this[this.version] = new cls(this);

    var pathPrefix = "";
    // Check if a prefix is passed in the config and strip any leading or trailing slashes from it.
    if (typeof config.pathPrefix == "string") {
        pathPrefix = "/" + config.pathPrefix.replace(/(^[\/]+|[\/]+$)/g, "");
        this.config.pathPrefix = pathPrefix;
    }

    this.setupRoutes();
};

(function() {
    this.setupRoutes = function() {
        var self = this;
        var api = this[this.version];
        var routes = api.routes;
        var defines = routes.defines;
        this.constants = defines.constants;
        this.requestHeaders = defines["request-headers"].map(function(header) {
            return header.toLowerCase();
        });
        delete routes.defines;

        function trim(s) {
            if (typeof s != "string")
                return s;
            return s.replace(/^[\s\t\r\n]+/, "").replace(/[\s\t\r\n]+$/, "");
        }

        function parseParams(msg, paramsStruct) {
            var params = Object.keys(paramsStruct);
            var paramName, def, value, type;
            for (var i = 0, l = params.length; i < l; ++i) {
                paramName = params[i];
                if (paramName.charAt(0) == "$") {
                    paramName = paramName.substr(1);
                    if (!defines.params[paramName]) {
                        throw new error.BadRequest("Invalid variable parameter name substitution; param '" +
                            paramName + "' not found in defines block", "fatal");
                    }
                    else {
                        def = paramsStruct[paramName] = defines.params[paramName];
                        delete paramsStruct["$" + paramName];
                    }
                }
                else
                    def = paramsStruct[paramName];

                value = trim(msg[paramName]);
                if (typeof value != "boolean" && !value) {
                    // we don't need to validation for undefined parameter values
                    // that are not required.
                    if (!def.required || (def["allow-empty"] && value === ""))
                        continue;
                    throw new error.BadRequest("Empty value for parameter '" +
                        paramName + "': " + value);
                }

                // validate the value and type of parameter:
                if (def.validation) {
                    if (!new RegExp(def.validation).test(value)) {
                        throw new error.BadRequest("Invalid value for parameter '" +
                            paramName + "': " + value);
                    }
                }

                if (def.type) {
                    type = def.type.toLowerCase();
                    if (type == "number") {
                        value = parseInt(value, 10);
                        if (isNaN(value)) {
                            throw new error.BadRequest("Invalid value for parameter '" +
                                paramName + "': " + msg[paramName] + " is NaN");
                        }
                    }
                    else if (type == "float") {
                        value = parseFloat(value);
                        if (isNaN(value)) {
                            throw new error.BadRequest("Invalid value for parameter '" +
                                paramName + "': " + msg[paramName] + " is NaN");
                        }
                    }
                    else if (type == "json") {
                        if (typeof value == "string") {
                            try {
                                value = JSON.parse(value);
                            }
                            catch(ex) {
                                throw new error.BadRequest("JSON parse error of value for parameter '" +
                                    paramName + "': " + value);
                            }
                        }
                    }
                    else if (type == "date") {
                        value = new Date(value);
                    }
                }
                msg[paramName] = value;
            }
        }

        function prepareApi(struct, baseType) {
            if (!baseType)
                baseType = "";
            Object.keys(struct).forEach(function(routePart) {
                var block = struct[routePart];
                if (!block)
                    return;
                var messageType = baseType + "/" + routePart;
                if (block.url && block.params) {
                    // we ended up at an API definition part!
                    var endPoint = messageType.replace(/^[\/]+/g, "");
                    var parts = messageType.split("/");
                    var section = Util.toCamelCase(parts[1].toLowerCase());
                    parts.splice(0, 2);
                    var funcName = Util.toCamelCase(parts.join("-"));

                    if (!api[section]) {
                        throw new Error("Unsupported route section, not implemented in version " +
                            self.version + " for route '" + endPoint + "' and block: " +
                            JSON.stringify(block));
                    }

                    if (!api[section][funcName]) {
                        if (self.debug)
                            Util.log("Tried to call " + funcName);
                        throw new Error("Unsupported route, not implemented in version " +
                            self.version + " for route '" + endPoint + "' and block: " +
                            JSON.stringify(block));
                    }

                    if (!self[section]) {
                        self[section] = {};
                        // add a utility function 'getFooApi()', which returns the
                        // section to which functions are attached.
                        self[Util.toCamelCase("get-" + section + "-api")] = function() {
                            return self[section];
                        };
                    }


                    // Support custom headers for specific route
                    block.requestHeaders = block['request-headers'] || [];
                    delete block['request-headers'];
                    block.requestHeaders = block.requestHeaders.map(function(header) {
                        return header.toLowerCase();
                    });
                    block.requestHeaders = block.requestHeaders.concat(self.requestHeaders);


                    self[section][funcName] = function(msg, callback) {
                        try {
                            parseParams(msg, block.params);
                        }
                        catch (ex) {
                            // when the message was sent to the client, we can
                            // reply with the error directly.
                            api.sendError(ex, block, msg, callback);
                            if (self.debug)
                                Util.log(ex.message, "fatal");
                            // on error, there's no need to continue.
                            return;
                        }

                        api[section][funcName].call(api, msg, block, callback);
                    };
                }
                else {
                    // recurse into this block next:
                    prepareApi(block, messageType);
                }
            });
        }

        prepareApi(routes);
    };

    this.authenticate = function(options) {
        if (!options) {
            this.auth = false;
            return;
        }
        if (!options.type || "basic|oauth|client|token".indexOf(options.type) === -1)
            throw new Error("Invalid authentication type, must be 'basic', 'oauth' or 'client'");
        if (options.type == "basic" && (!options.username || !options.password))
            throw new Error("Basic authentication requires both a username and password to be set");
        if (options.type == "oauth") {
            if (!options.token && !(options.key && options.secret))
                throw new Error("OAuth2 authentication requires a token or key & secret to be set");
        }
        if (options.type == "token" && !options.token)
            throw new Error("Token authentication requires a token to be set");

        this.auth = options;
    };

    function getRequestFormat(hasBody, block) {
        if (hasBody)
            return block.requestFormat || this.constants.requestFormat;

        return "query";
    }

    function getQueryAndUrl(msg, def, format, config) {
        var url = def.url;
        if (config.pathPrefix && url.indexOf(config.pathPrefix) !== 0) {
            url = config.pathPrefix + def.url;
        }
        var ret = {
            query: format == "json" ? {} : format == "raw" ? msg.data : []
        };
        if (!def || !def.params) {
            ret.url = url;
            return ret;
        }

        Object.keys(def.params).forEach(function(paramName) {
            paramName = paramName.replace(/^[$]+/, "");
            if (!(paramName in msg))
                return;

            var isUrlParam = url.indexOf(":" + paramName) !== -1;
            var valFormat = isUrlParam || format != "json" ? "query" : format;
            var val;
            if (valFormat != "json") {
                if (typeof msg[paramName] == "object") {
                    try {
                        msg[paramName] = JSON.stringify(msg[paramName]);
                        val = encodeURIComponent(msg[paramName]);
                    }
                    catch (ex) {
                        return Util.log("httpSend: Error while converting object to JSON: "
                            + (ex.message || ex), "error");
                    }
                }
                else if (def.params[paramName] && def.params[paramName].combined) {
                    // Check if this is a combined (search) string.
                    val = msg[paramName].split(/[\s\t\r\n]*\+[\s\t\r\n]*/)
                                        .map(function(part) {
                                            return encodeURIComponent(part);
                                        })
                                        .join("+");
                }
                else
                    val = encodeURIComponent(msg[paramName]);
            }
            else
                val = msg[paramName];

            if (isUrlParam) {
                url = url.replace(":" + paramName, val);
            }
            else {
                if (format == "json")
                    ret.query[paramName] = val;
                else if (format != "raw")
                    ret.query.push(paramName + "=" + val);
            }
        });
        ret.url = url;
        return ret;
    }

    this.httpSend = function(msg, block, callback) {
        var self = this;
        var method = block.method.toLowerCase();
        var hasFileBody = block.hasFileBody;
        var hasBody = !hasFileBody && ("head|get|delete".indexOf(method) === -1);
        var format = getRequestFormat.call(this, hasBody, block);
        var obj = getQueryAndUrl(msg, block, format, self.config);
        var query = obj.query;
        var url = this.config.url ? this.config.url + obj.url : obj.url;

        var path = url;
        var protocol = this.config.protocol || this.constants.protocol || "http";
        var host = block.host || this.config.host || this.constants.host;
        var port = this.config.port || this.constants.port || (protocol == "https" ? 443 : 80);
        var proxyUrl;
        if (this.config.proxy !== undefined) {
            proxyUrl = this.config.proxy;
        } else {
            proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        }
        if (proxyUrl) {
            path = Url.format({
                protocol: protocol,
                hostname: host,
                port: port,
                pathname: path
            });

            if (!/^(http|https):\/\//.test(proxyUrl))
                proxyUrl = "https://" + proxyUrl;

            var parsedUrl = Url.parse(proxyUrl);
            protocol = parsedUrl.protocol.replace(":", "");
            host = parsedUrl.hostname;
            port = parsedUrl.port || (protocol == "https" ? 443 : 80);
        }
        if (!hasBody && query.length)
            path += "?" + query.join("&");

        var headers = {
            "host": host,
            "content-length": "0"
        };
        if (hasBody) {
            if (format == "json")
                query = JSON.stringify(query);
            else if (format != "raw")
                query = query.join("&");
            headers["content-length"] = Buffer.byteLength(query, "utf8");
            headers["content-type"] = format == "json"
                ? "application/json; charset=utf-8"
                : format == "raw"
                    ? "text/plain; charset=utf-8"
                    : "application/x-www-form-urlencoded; charset=utf-8";
        }
        if (this.auth) {
            var basic;
            switch (this.auth.type) {
                case "oauth":
                    if (this.auth.token) {
                        path += (path.indexOf("?") === -1 ? "?" : "&") +
                            "access_token=" + encodeURIComponent(this.auth.token);
                    } else {
                        path += (path.indexOf("?") === -1 ? "?" : "&") +
                            "client_id=" + encodeURIComponent(this.auth.key) +
                            "&client_secret=" + encodeURIComponent(this.auth.secret);
                    }
                    break;
                case "token":
                    headers.authorization = "token " + this.auth.token;
                    break;
                case "basic":
                    basic = new Buffer(this.auth.username + ":" + this.auth.password, "ascii").toString("base64");
                    headers.authorization = "Basic " + basic;
                    break;
                default:
                    break;
            }
        }

        function callCallback(err, result) {
            if (callback) {
                var cb = callback;
                callback = undefined;
                cb(err, result);
            }
        }

        function addCustomHeaders(customHeaders) {
            Object.keys(customHeaders).forEach(function(header) {
                var headerLC = header.toLowerCase();
                if (block.requestHeaders.indexOf(headerLC) == -1)
                    return;
                headers[headerLC] = customHeaders[header];
            });
        }
        addCustomHeaders(Util.extend(msg.headers || {}, this.config.headers));

        if (!headers["user-agent"])
            headers["user-agent"] = "NodeJS HTTP Client";

        if (!("accept" in headers))
            headers.accept = this.config.requestMedia || this.constants.requestMedia;

        var options = {
            host: host,
            port: port,
            path: path,
            method: method,
            headers: headers
        };

        if (this.config.rejectUnauthorized !== undefined)
            options.rejectUnauthorized = this.config.rejectUnauthorized;

        if (this.debug)
            console.log("REQUEST: ", options);

        function httpSendRequest() {
            var req = require(protocol).request(options, function(res) {
                if (self.debug) {
                    console.log("STATUS: " + res.statusCode);
                    console.log("HEADERS: " + JSON.stringify(res.headers));
                }
                res.setEncoding("utf8");
                var data = "";
                res.on("data", function(chunk) {
                    data += chunk;
                });
                res.on("error", function(err) {
                    callCallback(err);
                });
                res.on("end", function() {
                    if (res.statusCode >= 400 && res.statusCode < 600 || res.statusCode < 10) {
                        callCallback(new error.HttpError(data, res.statusCode));
                    } else {
                        res.data = data;
                        callCallback(null, res);
                    }
                });
            });

            var timeout = (block.timeout !== undefined) ? block.timeout : self.config.timeout;
            if (timeout) {
                req.setTimeout(timeout);
            }

            req.on("error", function(e) {
                if (self.debug)
                    console.log("problem with request: " + e.message);
                callCallback(e.message);
            });

            req.on("timeout", function() {
                if (self.debug)
                    console.log("problem with request: timed out");
                callCallback(new error.GatewayTimeout());
            });

            // write data to request body
            if (hasBody && query.length) {
                if (self.debug)
                    console.log("REQUEST BODY: " + query + "\n");
                req.write(query + "\n");
            }

            if (block.hasFileBody) {
              var stream = fs.createReadStream(msg.filePath);
              stream.pipe(req);
            } else {
              req.end();
            }
        };

        if (hasFileBody) {
            fs.stat(msg.filePath, function(err, stat) {
                if (err) {
                    callCallback(err);
                } else {
                    headers["content-length"] = stat.size;
                    headers["content-type"] = mime.lookup(msg.name);
                    httpSendRequest();
                }
            });
        } else {
            httpSendRequest();
        }
    };
}).call(Client.prototype);
