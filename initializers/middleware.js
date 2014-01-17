/*jslint nomen: true */
/*
 * Copyright (C) 2013 TopCoder Inc., All Rights Reserved.
 *
 * @version 1.1
 * @author vangavroche, TCSASSEMBLER
 * changes in 1.1:
 * - add cache support (add preCacheProcessor and postCacheProcessor)
 */
"use strict";

/**
 * Module dependencies.
 */
var http = require('http');
var xml2js = require('xml2js');
var async = require('async');
var _ = require('underscore');
var crypto = require('crypto');

/**
 * Define the config to get the API Host from the environment variables.
 */
var config = {
    apiHost: process.env.TC_API_HOST || 'api.topcoder.com'
};

/**
 * Helper function to get the header value from the request object
 * @param {Object} req The request from where the header is obtained
 * @param {String} name The name of the header.
 */
var getHeader = function (req, name) {
    name = name.toLowerCase();
    switch (name) {
    case 'referer':
    case 'referrer':
        return req.headers.referrer || this.headers.referer;
    default:
        return req.headers[name];
    }
};


/**
 * Expose the middleware function to add the pre-processor for authentication via Oauth.
 *
 * @param {Object} api The api object used to access the infrastructure.
 * @param {Function<err>} next The callback function
 */
exports.middleware = function (api, next) {
    var oauthProcessor, authorize;

    /**
     * Helper function to authorize request, given the header and the action scope.
     *
     * @param {String} authHeader The authorization header value
     * @param {String} actionScope The permission scope of the given action
     * @param {Function<err, status>} done The callback function
     */
    authorize = function (authHeader, actionScope, done) {

        api.log("Authorize " + authHeader + " for " + actionScope);

        if (!authHeader || authHeader.trim().length === 0) {
            done("Authentication Header is missing", 403);
        } else {

            /**
             * Prepare the request options to sent the Authorization header for validation.
             */
            var requestOptions = {
                host: config.apiHost,
                path: '/oauth/oauth/validate',
                headers: {
                    Authorization: authHeader
                }
            };

            /**
             * Send validation request to the API endpoint that serves the OAuth token validation.
             */
            http.request(requestOptions, function (httpResponse) {
                httpResponse.setEncoding('utf8');
                var responseXML = '';
                httpResponse.on("data", function (chunk) {
                    responseXML += chunk;
                });

                httpResponse.on("end", function () {
                    var parseString = xml2js.parseString, tokenScopes;

                    parseString(responseXML, function (err, result) {
                        if (err) {
                            done("OAuth server returned invalid xml: " + responseXML, 500);
                        } else if (!result) {
                            done("OAuth server returned null. Check if your access token is correct and valid.", 500);
                        } else {
                            if (result.accessTokenValidation && result.accessTokenValidation.tokenScopes) {
                                var i;
                                if (result.accessTokenValidation.tokenScopes.length) {
                                    tokenScopes = result.accessTokenValidation.tokenScopes;
                                    for (i = 0; i < tokenScopes.length; i += 1) {
                                        if (tokenScopes[i].permission.indexOf(actionScope) !== -1) {
                                            done(null);
                                            return;
                                        }
                                    }
                                }
                            }
                            done("Not authorized", 403);
                        }
                    });
                });
            }).on("error", function () {
                api.log('Error sending request to the OAuth server', 'error');
                done("Error occurs during OAuth authorization", 500);
            }).end();
        }
    };

    /**
     * The pre-processor that check the action via OAuth.
     * Only the actions that have configured "permissionScope:<permission-scope>" are checked here
     *
     * @param {Object} connection The connection object for the current request
     * @param {Object} actionTemplate The metadata of the current action object
     * @param {Function<connection, toRender>} next The callback function
     */
    oauthProcessor = function (connection, actionTemplate, next) {
        if (actionTemplate.permissionScope) {
            authorize(getHeader(connection.rawConnection.req, 'Authorization'),
                actionTemplate.permissionScope, function (error, statusCode) {
                    if (error) {
                        connection.error = error;
                        connection.responseHttpCode = statusCode;
                        next(connection, false);
                    } else {
                        next(connection, true);
                    }
                });

        } else {
            next(connection, true);
        }
    };

    /**
     * The pre-processor that checks if user is slamming.
     *
     * @param {Object} connection The connection object for the current request
     * @param {Object} actionTemplate The metadata of the current action object
     * @param {Function<connection, toRender>} next The callback function
     * @since 1.1
     */
    function preThrottleProcessor(connection, actionTemplate, next) {
        var key = api.helper.createCacheKey(connection, true);
        api.log('Throttle check. Action: "' + actionTemplate.name + '" connection.id: "' + connection.id + '" key: "' + key + '"', 'debug');
        api.helper.getCachedValue(key, function (err, value) {
            if (value) {
                api.log('Ignoring duplicate request from same user!', 'notice');
                connection.response.error = api.helper.apiCodes.badRequest;
                connection.response.error.details = 'This request was ignored because you have an identical request still processing.';
                connection.rawConnection.responseHttpCode = api.helper.apiCodes.badRequest.value;
                next(connection, false);
            } else {
                api.cache.save(key, key, 30000, function (err) {
                    if (err) {
                        api.helper.handleError(api, connection, err);
                    }
                    next(connection, true);
                });
            }
        });
    }

    /**
     * The post-processor to clear user for further requests.
     *
     * @param {Object} connection The connection object for the current request
     * @param {Object} actionTemplate The metadata of the current action object
     * @param {Boolean} toRender The flag whether response should be rendered
     * @param {Function<connection, toRender>} next The callback function
     * @since 1.1
     */
    function postThrottleProcessor(connection, actionTemplate, toRender, next) {

        var key = api.helper.createCacheKey(connection, true);
        //api.log('connection.id: ' + connection.id, 'debug');
        //api.log('key: ' + key, 'debug');
        api.cache.destroy(key, function (err) {
            if (err) {
                api.log('Throttle cache object was not found. This is unexpected. ' + err, 'warn');
            }
            next(connection, toRender);
        });
    }


    /**
     * The pre-processor that check the cache.
     * If cache exists then cached response is returned.
     *
     * @param {Object} connection The connection object for the current request
     * @param {Object} actionTemplate The metadata of the current action object
     * @param {Function<connection, toRender>} next The callback function
     * @since 1.1
     */
    function preCacheProcessor(connection, actionTemplate, next) {
        //by default enabled, but turn it off if the global cache timeout is set to less to zero and local action doesn't have a timeout set (this logic is mostly for test purposes)
        if (actionTemplate.cacheEnabled === false || (api.configData.general.defaultCacheLifetime < 0 && !actionTemplate.cacheLifetime)) {
            next(connection, true);
            return;
        }

        var key = api.helper.createCacheKey(connection);
        api.helper.getCachedValue(key, function (err, value) {
            if (value) {
                api.log('Returning cached response', 'debug');
                connection.response = value;
                //manually call the postThrottleProcessor here since we're returning the cache value and halting further processing
                postThrottleProcessor(connection, actionTemplate, false, next)
                //next(connection, false);
            } else {
                next(connection, true);
            }
        });
    }

    /**
     * The post-processor that save response to cache.
     * Cache is not saved if error occurred.
     *
     * @param {Object} connection The connection object for the current request
     * @param {Object} actionTemplate The metadata of the current action object
     * @param {Boolean} toRender The flag whether response should be rendered
     * @param {Function<connection, toRender>} next The callback function
     * @since 1.1
     */
    function postCacheProcessor(connection, actionTemplate, toRender, next) {
        //by default enabled
        if (actionTemplate.cacheEnabled === false) {
            next(connection, toRender);
            return;
        }

        async.waterfall([
            function (cb) {
                var key = api.helper.createCacheKey(connection);
                api.helper.getCachedValue(key, cb);
            }, function (value, cb) {
                if (value || connection.response.error) {
                    cb();
                    return;
                }
                var response = _.clone(connection.response),
                    lifetime = actionTemplate.cacheLifetime || api.configData.general.defaultCacheLifetime,
                    key = api.helper.createCacheKey(connection);
                delete response.serverInformation;
                delete response.requestorInformation;
                api.cache.save(key, response, lifetime, cb);
            }
        ], function (err) {
            if (err) {
                api.helper.handleError(api, connection, err);
            }
            next(connection, toRender);
        });
    }

    api.actions.preProcessors.push(oauthProcessor);
    api.actions.preProcessors.push(preThrottleProcessor);
    api.actions.preProcessors.push(preCacheProcessor);
    api.actions.postProcessors.push(postCacheProcessor);
    api.actions.postProcessors.push(postThrottleProcessor);
    next();
};
