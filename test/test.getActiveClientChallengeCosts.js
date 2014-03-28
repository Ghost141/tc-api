/*
 * Copyright (C) 2014 TopCoder Inc., All Rights Reserved.
 *
 * @version 1.0
 * @author  TCSASSEMBLER
 */
'use strict';
/*global describe, it, before, beforeEach, after, afterEach */
/*jslint node: true, stupid: true, unparam: true */

/**
 * Module dependencies.
 */
var request = require('supertest');
var assert = require('chai').assert;
var async = require('async');
var _ = require('underscore');

var testHelper = require('./helpers/testHelper');
var SQL_DIR = __dirname + '/sqls/activeClientChallengeCosts/';
var API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8080';

describe('Get Active Client Challenge Costs API', function () {
    this.timeout(180000);     // The api with testing remote db could be quit slow

    var errorObject = require('../test/test_files/expected_get_active_client_challenge_costs_error_message'),
        admin = testHelper.generateAuthHeader({ sub: "ad|132456" }),
        member = testHelper.generateAuthHeader({ sub: "ad|132457" });

    /**
     * Clear database
     * @param {Function<err>} done the callback
     */
    function clearDb(done) {
        async.waterfall([
            function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'time_oltp__clean', 'time_oltp', cb);
            }, function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'tcs_catalog__clean', 'tcs_catalog', cb);
            }, function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'corporate_oltp__clean', 'corporate_oltp', cb);
            }
        ], done);
    }

    /**
     * This function is run before all tests.
     * Generate tests data.
     * @param {Function<err>} done the callback
     */
    before(function (done) {
        async.waterfall([
            clearDb,
            function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'corporate_oltp__insert_test_data', 'corporate_oltp', cb);
            },
            function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'tcs_catalog__insert_test_data', 'tcs_catalog', cb);
            },
            function (cb) {
                testHelper.runSqlFile(SQL_DIR + 'time_oltp__insert_test_data', 'time_oltp', cb);
            }
        ], done);
    });

    /**
     * This function is run after all tests.
     * Clean up all data.
     * @param {Function<err>} done the callback
     */
    after(function (done) {
        clearDb(done);
    });

    /**
     * Create a http request and test it.
     * @param {String} url - the request url.
     * @param {Number} expectStatus - the expected request response status.
     * @param {Object} authHeader - the auth header for request.
     * @param {Function} cb - the call back function.
     */
    function createRequest(url, expectStatus, authHeader, cb) {
        var req = request(API_ENDPOINT)
            .get('/v2/reports/client/activeCosts' + url)
            .set('Accept', 'application/json');
        if (authHeader) {
            req.set('Authorization', authHeader);
        }
        req.expect('Content-Type', /json/)
            .expect(expectStatus)
            .end(cb);
    }

    /**
     * assert the bad response.
     * @param {String} url - the request url
     * @param {Number} expectStatus - the expect status.
     * @param {String} errorMessage - the expected error message.
     * @param {Object} authHeader - the request auth header.
     * @param {Function} cb - the callback function.
     */
    function assertBadResponse(url, expectStatus, errorMessage, authHeader, cb) {
        createRequest(url, expectStatus, authHeader, function (err, result) {
            if (!err) {
                assert.equal(result.body.error.details, errorMessage, 'invalid error message');
            } else {
                cb(err);
                return;
            }
            cb();
        });
    }

    /**
     * Assert the success response.
     * @param url
     * @param expectResponse
     * @param cb
     */
    function assertSuccess(url, expectResponse, cb) {
        createRequest(url, 200, admin, function (err, res) {
            if (err) {
                cb(err);
                return;
            }
            res.body.history.forEach(function (item) {
                assert.isTrue(_.isDate(new Date(item.postingDate)));
                assert.isTrue(_.isDate(new Date(item.completionDate)));
                assert.isTrue(_.isDate(new Date(item.regEndDate)));
                assert.isTrue(_.isDate(new Date(item.subEndDate)));
                assert.isTrue(_.isDate(new Date(item.challengeScheduledEndDate)));
                delete item.postingDate;
                delete item.completionDate;
                delete item.regEndDate;
                delete item.subEndDate;
                delete item.challengeScheduledEndDate;
                if (item.checkpointEndDate !== undefined) {
                    assert.isTrue(_.isDate(new Date(item.checkpointEndDate)));
                    delete item.checkpointEndDate;
                }
            });
            delete res.body.requesterInformation;
            delete res.body.serverInformation;
            var expect = require('./test_files/' + expectResponse);
            assert.deepEqual(res.body, expect, 'invalid response');
            cb();
        });
    }

    /**
     * Test when anonymous user call this api.
     */
    it('should return unauthorized error. The caller is anonymous user.', function (done) {
        assertBadResponse('', 401, errorObject.unauthorized, null, done);
    });

    /**
     * Test when member call this api.
     */
    it('should return forbidden error. The caller is member.', function (done) {
        assertBadResponse('', 403, errorObject.forbidden, member, done);
    });

    /**
     * Test when clientId is not a number.
     */
    it('should return bad Request. The clientId is not a number.', function (done) {
        assertBadResponse('?clientId=abc', 400, errorObject.clientId.notNumber, admin, done);
    });

    /**
     * Test when clientId is not integer.
     */
    it('should return bad Request. The clientId is not integer.', function (done) {
        assertBadResponse('?clientId=1.2345', 400, errorObject.clientId.notInteger, admin, done);
    });

    /**
     * Test when clientId is negative.
     */
    it('should return Bad Request. The clientId is negative.', function (done) {
        assertBadResponse('?clientId=-1', 400, errorObject.clientId.notPositive, admin, done);
    });

    /**
     * Test when clientId is zero.
     */
    it('should return bad Request. The clientId is zero.', function (done) {
        assertBadResponse('?clientId=0', 400, errorObject.clientId.notPositive, admin, done);
    });

    /**
     * Test when client is not exist.
     */
    it('should return not found error. The client is not exist(pass clientId).', function (done) {
        assertBadResponse('?clientId=100', 404, errorObject.notFound, admin, done);
    });

    /**
     * Test when client is not exist.
     */
    it('should return not found error. The client is not exist(pass sfdcAccountId).', function (done) {
        assertBadResponse('?sfdcAccountId=abc', 404, errorObject.notFound, admin, done);
    });

    /**
     * Should return success results.
     */
    it('should return success results.', function (done) {
        assertSuccess('', 'expected_get_active_client_challenge_costs_1', done);
    });

    /**
     * Should return success results.
     */
    it('should return success results. filter client', function (done) {
        assertSuccess('?clientId=2001', 'expected_get_active_client_challenge_costs_2', done);
    });

    /**
     * Should return success results.
     */
    it('should return success results. filter client by customerNumber.', function (done) {
        assertSuccess('?customerNumber=testClient2001', 'expected_get_active_client_challenge_costs_2', done);
    });

    /**
     * Should return success results.
     */
    it('should return success results. filter client by sfdcAccountId', function (done) {
        assertSuccess('?sfdcAccountId=cmc', 'expected_get_active_client_challenge_costs_2', done);
    });

    /**
     * Test case insensitive filter.
     */
    it('should return success results. Test case insensitive.', function (done) {
        assertSuccess('?customerNumber=TESTCLIENT2001', 'expected_get_active_client_challenge_costs_2', done);
    });
});
