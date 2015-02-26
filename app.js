#!/usr/bin/env node
"use strict";

/*
	FitBit Dumper
	
	A utility to automatically dump portions of FitBit data to a local SqLite
	database for further processing or export into CSV.

	Copyright (c) 2015 richard.prinz@min.at

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in
	all copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
	THE SOFTWARE.
*/


// ----------------------------------------------------------------------------
// make configuration changes here

var FB_CONSUMER_KEY = '2fb466d29ca149799037a6a263ba0bfc';
var FB_CONSUMER_SEC = '91f273d309e746119b4f0f9303363cb7';

var CSV_DELIMITER = ';';
var CSV_QUOTE = '"';
//var CSV_LOCALE = 'de-DE';
var CSV_LOCALE = undefined;

// ----------------------------------------------------------------------------
// dont change anything after this line

var Q = require('q'),
	util = require('util'),
	intl = require('intl'),
	os = require('os'),
	fs = require('fs'),
	sprintf = require('sprintf').sprintf,
	colors = require('colors'),
	url = require('url'),
	spawn = require('open'),
	stdio = require('stdio'),
	moment = require('moment'),
	sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('./fitbit.db');

var myName = process.argv[1];

var FAKE_URL = 'http://dummy';

var fitbitClient = require('fitbit-js')
		(FB_CONSUMER_KEY, FB_CONSUMER_SEC, FAKE_URL);

var VERSION = '1.0';
var LOG_DEBUG = 0;
var LOG_INFO = 1;
var LOG_OK = 2;
var LOG_WARNING = 3;
var LOG_ERROR = 4;

var master_token = {};
var oauth_token;
var oauth_verifier;

var DATE_FORMAT = 'YYYYMMDD';
var DISPLAY_DATE_FORMAT = 'YYYY.MM.DD';
var SQL_DATE_FORMAT = 'YYYY-MM-DD';
var FB_API_DATE_FORMAT = 'YYYY-MM-DD';
var DEFAULT_DAYS = 13;
var now = moment();
var start_date = now.clone();
var end_date = now.clone();
start_date.subtract(DEFAULT_DAYS, 'days');
var days_to_dump;

//var PROGRESS_CHARS = '-\|/';
var PROGRESS_CHARS = ['.    ','..   ','...  ','.... ', '.....'];
var progress_tick = null;
var progress_prompt = '';
var processed_count = 0;
var ignored_count = 0;

// command line options
var options = stdio.getopt({
	'start': { key: 's', description: 'Start date ' + DATE_FORMAT, args: 1 },
	'end': { key: 'e', description: 'End date ' + DATE_FORMAT, args: 1 },
	'force': { key: 'f', description: 'Force download from FitBit, even if local data already exists', args: 1 },
	'verbose': { key: 'v', description: 'Verbose debug output' },
	'quiet': { key: 'q', description: 'No output at all; overrules --verbose; assumes YES to all questions' },
	'dbinit': { key: 'i', description: '(Re)Initialize database. ' + 'DELETES ALL EXISTING LOCAL DATA!'.red },
	'dbdump': { key: 'd', description: 'Dump out database as CSV' },
	'register': { key: 'r', description: '(Re)Register with FitBit' }
});



// ----------------------------------------------------------------------------
// Fake some objects to mimic express for command line usage

var fakeRequest = {
	cookies: {},
	url: FAKE_URL
};

var fakeResponse = {
	cookie: function(name, value) {
		log(LOG_DEBUG, true, 'res:cookie(' + name + ')', value);
		
		fakeRequest.cookies[name] = value;
	},

	redirect: function(redirectToUrl) {
		log(LOG_DEBUG, true, 'res:redirect', redirectToUrl);
		
		fakeRequest.url = redirectToUrl;

		if (redirectToUrl.substring(0, 51) == "https://www.fitbit.com/oauth/authorize?oauth_token=") {
			var pu = url.parse(redirectToUrl, true);
			oauth_token = pu.query.oauth_token;
			log(LOG_DEBUG, true, 'oauth_token', oauth_token);

			console.log('\r\n\r\nUse your browser to open this URL:\r\n');
			console.log(redirectToUrl.cyan);
			console.log('\r\nThen come back and enter the PIN here\r\n');

			// start user browser for fitbit registration
			spawn(redirectToUrl, function(error) {
				//if(error) {
				//	log(LOG_ERROR, 'Error starting user web browser');
				//}
			});

			// ask user for pin from fitbit registration
			ask("PIN", /.+/)
				.then(function(pin) {
					console.log();
					oauth_verifier = pin;

					// build new url to access token
					pu.search = null;
					pu.query.oauth_verifier = pin;
					fakeRequest.url = url.format(pu);

					requestToken()
						.then(doExit)
						.fail(doExit);		
				});
		}
	}
};



// ----------------------------------------------------------------------------
// Main part

main()
	.then(doExit)
	.fail(doExit);		

//process.stdin.setEncoding('utf8');

function main() {
	var deferred = Q.defer();
	
	log(LOG_INFO, true, 'FitBit Dumper, Version ' + VERSION);
	log(LOG_DEBUG, true, 'FitBit client, Version ' + fitbitClient.version);

	if(options.register)
		if(options.quiet)
			return requestToken();
		else
			return ask("Reregister application with FitBit [yn] ?", /[yYnN]/)
				.then(function(answer) {
					if(answer == 'y' || answer == 'Y')
						return requestToken();
					else
						return Q();
				});
	
	if(options.dbinit)
		if(options.quiet)
			return createDatabase();
		else
			return ask("Initialize database (existing data will be deleted) [yn] ?", /[yYnN]/)
				.then(function(answer) {
					if(answer == 'y' || answer == 'Y')
						return createDatabase();
					else
						return Q();
				});
	
	if(options.start) {
		start_date = checkDate(options.start, 'start date');
		if(!start_date)
			deferred.reject(new Error('Invalid start date'));
		if(!options.end)
			end_date = start_date.clone().add(DEFAULT_DAYS, 'days');
	}

	if(options.end) {
		end_date = checkDate(options.end, 'end date');
		if(!end_date)
			deferred.reject(new Error('Invalid end date'));
		if(!options.start)
			start_date = end_date.clone().subtract(DEFAULT_DAYS, 'days');
	}

	if(start_date > end_date) {
		var tmp = start_date;
		start_date = end_date;
		end_date = tmp;
	}

	days_to_dump = end_date.diff(start_date, 'days') + 1;

	if(options.dbdump)
		return dumpDatabase();
	
	// check if FitBitDump already authorized
	fs.exists('./fitbit.oauth', function(exists) {
		if(exists)
			doWork()
				.then(function() {
					log(LOG_OK, true, 
						'Processed ' + processed_count.toString().cyan + ', ' +
						'ignored: ' + ignored_count.toString().cyan);
					deferred.resolve();
				})
				.fail(function(error) {
					deferred.reject(error);
				});
		else {
			log(LOG_WARNING, true, 'OAuth token not available, start registering',
				fitbitClient.version);
			log(LOG_WARNING, true, 'If this is the first time use this software you have');
			log(LOG_WARNING, true, 'to register it with your FitBit account.');
			requestToken()
				.then(function() {
					deferred.resolve();
				})
				.fail(function(error) {
					deferred.reject(error);
				});
		}
	});
	
	return deferred.promise;
}

function doWork() {
	var deferred = Q.defer();
	
	processed_count = 0;
	
	log(LOG_INFO, true, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
		
	fs.readFile("./fitbit.oauth", 'utf8', function(error, data) {
		if(error) {
			log(LOG_ERROR, true, 'Invalid local OAuth token format. ' +
				'Use -r to initialize.');
			deferred.reject(new Error(error));
		}

		if(!error && data) {
			var queue = [];
			master_token = JSON.parse(data);
			log(LOG_OK, true, 'Using FitBit API with local OAuth tokens', master_token);
			log(LOG_INFO, true, 'Processing ...');

			showProgress('Get data', true);
			
			// get data for each day from fitbit
			var date = start_date.clone();
			var cnt = days_to_dump;
			do {
				queue.push(
					checkFitBitRecord(date.clone())
						.then(function(result) {
							if(!result.recordAvailable) {
								processed_count++;
								return requestData(result.date);
							}
							else
								ignored_count++;
						}));
				date.add(1, 'days');
				cnt--;
			} while(cnt > 0);
			
			Q.all(queue)
				.then(function(result) {
					hideProgress();
					deferred.resolve();
				})
				.fail(function(error) {
					hideProgress();
					deferred.reject(error);
				});
		}
	});
	
	return deferred.promise;
}

function doExit(error) {
	if(error)
		log(LOG_ERROR, true, 'FitBit dumper completed with errors'.red, error);
	else
		log(LOG_OK, true, 'FitBit dumper completed');
	db.close();
	process.exit((error ? 1 : 0));
}



// ----------------------------------------------------------------------------
// FitBit functions

function requestToken() {
	var deferred = Q.defer();
	
	// request an app token/pin
	log(LOG_INFO, true, 'Requesting FitBit OAuth token ...');

	fitbitClient.getAccessToken(fakeRequest, fakeResponse, function (error, newToken) {
		if(error) {
			log(LOG_ERROR, true, 'Error requesting OAuth token');
			deferred.reject(error);
		}
		else {
//console.log('----------');
//console.log(util.inspect(newToken, { showHidden: true, depth: null, colors: true }));
//console.log('----------');
			if(newToken) {
				master_token = newToken;
				log(LOG_OK, true, 'New OAuth token available', master_token);

				// save oauth token
				fs.writeFile('./fitbit.oauth', 
					JSON.stringify(newToken, null, 4), 
					function(error) {
						if(error) {
							log(LOG_ERROR, true, 'Invalid OAuth token format');
							deferred.reject(new Error(error));
						}
						else
							log(LOG_OK, true, 'FitBit OAuth credentials saved');
							
						deferred.resolve();
					});
			}
		}
	});
	
	return deferred.promise;
}

function requestData(date) {
	//log(LOG_INFO, true, 'Calling FitBit data API ...');
	
	var queue = [];
	
	// https://wiki.fitbit.com/display/API/API-Get-Activities
	var actUrl = '/user/-/activities/date/' + date.format(FB_API_DATE_FORMAT) + '.json';
	// https://wiki.fitbit.com/display/API/API-Get-Body-Weight
	var weightUrl = '/user/-/body/log/weight/date/' + date.format(FB_API_DATE_FORMAT) + '.json';
	// https://wiki.fitbit.com/display/API/API-Get-Sleep
	var sleepUrl = '/user/-/sleep/date/' + date.format(FB_API_DATE_FORMAT) + '.json';
	
	queue.push(callFitBitApi('GET', actUrl));
	queue.push(callFitBitApi('GET', weightUrl));
	queue.push(callFitBitApi('GET', sleepUrl));
	
	return Q.all(queue)
		.then(function(results) {
			var activities = results[0];
			var weight = results[1];
			var sleep = results[2];
			
			return saveFitBitRecord(date, activities, weight, sleep);
		});
}

function callFitBitApi(method, url) {
	var deferred = Q.defer();
	
	showProgress('Fitbit API');
	
	fitbitClient.apiCall(
		method, 
		url,
		{ token: master_token },
		function(error, res, activities) {
			if(error)
				deferred.reject(error);
			else
				deferred.resolve(activities);
		});
	
	return deferred.promise;
}



// ----------------------------------------------------------------------------
// Database functions

function createDatabase() {
	var deferred = Q.defer();
	
	log(LOG_INFO, true, 'Initializing database');

	db.serialize(function() {
		db.run('DROP TABLE IF EXISTS data', function(error) {
			if(error) {
				log(LOG_ERROR, true, 'Error droping data table');
				deferred.reject(new Error(error));
			}
			else
				db.run('CREATE TABLE data (' +
					'date INTEGER NOT NULL, ' +
					'steps INTEGER NOT NULL DEFAULT 0, ' +
					'floors INTEGER NOT NULL DEFAULT 0, ' +
					'burnedCal INTEGER NOT NULL DEFAULT 0, ' +
					'lightAct INTEGER NOT NULL DEFAULT 0, ' +
					'mediumAct INTEGER NOT NULL DEFAULT 0, ' +
					'highAct INTEGER NOT NULL DEFAULT 0, ' +
					'weightKg FLOAT NOT NULL DEFAULT 0.0, ' +
					'weightTime INTEGER DEFAULT NULL, ' +
					'weightBmi FLOAT NOT NULL DEFAULT 0, ' +
					'sleepStartTime INTEGER DEFAULT 0,' +
					'MinutesToFallAsleep INTEGER NOT NULL DEFAULT 0, ' +
					'AwakeningCount INTEGER NOT NULL DEFAULT 0, ' +
					'AwakeCount INTEGER NOT NULL DEFAULT 0, ' +
					'MinutesAwake INTEGER NOT NULL DEFAULT 0, ' + 
					'MinutesRestless INTEGER NOT NULL DEFAULT 0, ' +
					'DurationMs INTEGER NOT NULL DEFAULT 0, ' + 
					'RestlessCount INTEGER NOT NULL DEFAULT 0, ' +
					'MinutesToAwake INTEGER NOT NULL DEFAULT 0, ' +
					'MinutesAfterWakeup INTEGER NOT NULL DEFAULT 0, ' +
					'Efficiency FLOAT NOT NULL DEFAULT 0.0' + 
					')', function(error) {
						if(error) {
							log(LOG_ERROR, true, 'Error creating data table');
							deferred.reject(new Error(error));
						}
						else {
							db.run('CREATE UNIQUE INDEX data_date ON ' +
								'data(date);', function(error) {
									if(error) {
										log(LOG_ERROR, true, 'Error creating data table index', error);
										deferred.reject(new Error(error));
									}
									else {
										log(LOG_OK, true, 'Database successfully initialized');
										deferred.resolve();
									}
								});								
						}
					});
		});
    });
	
	return deferred.promise;
}

function saveFitBitRecord(date, activities, weight, sleep) {
	var deferred = Q.defer();
	
	log(LOG_DEBUG, true, 'Save FitBit data to database ' + 
		date.format(SQL_DATE_FORMAT).cyan);

	showProgress('Save to database');
	
	db.serialize(function() {
		// Weight
		var weightKg = 0.0;
		var weightTime = 'NULL';
		var weightBmi = 0.0;
		if(weight.weight && weight.weight.length > 0) {
			var w = weight.weight[0];
			weightKg = w.weight;
			weightTime = "time('" + w.time + "')";
			weightBmi = w.bmi;
		}
		
		// Sleep
		var sleepStartTime = 'NULL';
		var MinutesToFallAsleep = 0;
		var AwakeningCount = 0;
		var AwakeCount = 0;
		var MinutesAwake = 0;
		var MinutesRestless = 0;
		var DurationMs = 0;
		var RestlessCount = 0;
		var MinutesToAwake = 0;
		var MinutesAfterWakeup = 0;
		var Efficiency = 0.0;
		if(sleep.sleep && sleep.sleep.length > 0) {
			var s;
			for(var i = 0; i <= sleep.sleep.length; i++) {
				s = sleep.sleep[i];
				if(s.isMainSleep) {
					sleepStartTime = "datetime('" + s.startTime + "')";
					MinutesToFallAsleep = s.minutesToFallAsleep;
					AwakeningCount = s.awakeningsCount;
					AwakeCount = s.awakeCount;
					MinutesAwake = s.minutesAwake;
					MinutesRestless = s.restlessDuration;
					DurationMs = s.duration;
					RestlessCount = s.restlessCount;
					MinutesToAwake = s.awakeDuration;
					MinutesAfterWakeup = s.minutesAfterWakeup;
					Efficiency = s.efficiency;
					break;
				}
			}
		}
		
		var orReplace = (options.force ? 'OR REPLACE' : '');
		var sql = "INSERT " + orReplace + " INTO data VALUES (" +
			"(date('" + date.format(SQL_DATE_FORMAT) + "'))," +
			activities.summary.steps + ',' + activities.summary.floors + ',' +
			activities.summary.caloriesOut + ',' + activities.summary.fairlyActiveMinutes + ',' +
			activities.summary.lightlyActiveMinutes + ',' + activities.summary.veryActiveMinutes + ',' +
			weightKg + ',' + weightTime + ',' + weightBmi + ',' +
			sleepStartTime + ',' + MinutesToFallAsleep + ',' + AwakeningCount + ',' +
			AwakeCount + ',' + MinutesAwake + ',' + MinutesRestless + ',' + DurationMs + ',' +
			RestlessCount + ',' + MinutesToAwake + ',' + MinutesAfterWakeup + ',' + 
			Efficiency +
			')';
		log(LOG_DEBUG, true, 'SQL insert statement', sql);
			
		db.run(sql,
			function(error) {
				if(error) {
					hideProgress();
					log(LOG_ERROR, true, 'Error writing database', error);
					
					// ignore error and continue with next action if any
					deferred.resolve();
					
					// cancel on any error
					//deferred.reject(error);
				}
				else {
					log(LOG_DEBUG, true, 'FitBit data successfully saved');
					deferred.resolve();
				}
			});
	});
	
	return deferred.promise;
}

function checkFitBitRecord(date) {
	var deferred = Q.defer();
	
	log(LOG_DEBUG, true, 'Check FitBit data in database for date ' + 
		date.format(SQL_DATE_FORMAT).cyan);
		
	if(options.force) {
		log(LOG_DEBUG, true, 'Local record availability check for date ' + 
			date.format(SQL_DATE_FORMAT).cyan + 
			' omitted');
		deferred.resolve({
			recordAvailable: false, 
			date: date
		});
		return deferred.promise;
	}
	
	showProgress(undefined, true);
	
	var sql = "SELECT COUNT(*) AS count FROM data " +
		"WHERE date = (date('" + date.format(SQL_DATE_FORMAT) + "'))";
	log(LOG_DEBUG, true, 'SQL check statement', sql);
		
	db.get(sql,
		function(error, result) {
			if(error) {
				log(LOG_ERROR, true, 'Error checking database for date ' +
					date.format(SQL_DATE_FORMAT).cyan);
				deferred.reject(error);
			}
			else {
				var recordAvailable = result.count > 0;
				
				if(recordAvailable)
					log(LOG_DEBUG, true, 'Local record available for date ' + 
						date.format(SQL_DATE_FORMAT).cyan + 
						' no data requested from FitBit');
				else
					log(LOG_DEBUG, true, 'No local record available for date ' + 
						date.format(SQL_DATE_FORMAT).cyan + 
						' request data from FitBit');
				
				deferred.resolve({
					recordAvailable: recordAvailable, 
					date: date
				});
			}
		});
	
	return deferred.promise;
}

function dumpDatabase() {
	var deferred = Q.defer();
	
	// quick and dirty CSV generation
	var delimiter = CSV_DELIMITER;
	var quote = CSV_QUOTE;
			
	log(LOG_INFO, true, 'Dump FitBit records');
	log(LOG_INFO, true, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
	
	console.log(
		'id' + delimiter +
		'date' + delimiter +
		'steps' + delimiter +
		'floors' + delimiter +
		'burnedCal' + delimiter +
		'lightAct' + delimiter +
		'mediumAct' + delimiter +
		'highAct' + delimiter + 
		'weightKg' + delimiter +
		'weightTime' + delimiter +
		'weightBmi' + delimiter +
		'sleepStartTime' + delimiter +
		'MinutesToFallAsleep' + delimiter +
		'AwakeningCount' + delimiter +
		'AwakeCount' + delimiter +
		'MinutesAwake' + delimiter +
		'MinutesRestless' + delimiter +
		'DurationMs' + delimiter +				
		'RestlessCount' + delimiter +
		'MinutesToAwake' + delimiter +
		'MinutesAfterWakeup' + delimiter +
		'Efficiency'
	);
	
	var sql = 'SELECT rowid AS id, * ' +
			'FROM data ' + 
			"WHERE date >= date('" + start_date.format(SQL_DATE_FORMAT) + "') " + 
			"AND date <= date('" + end_date.format(SQL_DATE_FORMAT) + "') " +
			'ORDER BY date ASC';
	log(LOG_DEBUG, true, 'SQL dump statement', sql);
			
	db.each(sql, function(error, row) {
		if(error) {
			log(LOG_ERROR, true, 'Error reading database');
			deferred.reject(error);
		}
		else {
			log(LOG_DEBUG, true, 'DB record', row);

			var weightTime = (!row.weightTime || row.weightTime === 'null' ?
				'' : quote + row.weightTime + quote);
			var sleepStartTime = (!row.sleepStartTime || row.sleepStartTime === 'null' ?
				'' : quote + row.sleepStartTime + quote);
				
//console.log(row.weightKg);			
//console.log(typeof(row.weightKg));
//console.log(parseFloat(row.weightKg));
//console.log(row.weightKg.toLocaleString('de'));

			console.log(
				row.id + delimiter +
				quote + row.date + quote + delimiter +
				row.steps + delimiter +
				row.floors + delimiter +
				row.burnedCal + delimiter +
				row.lightAct + delimiter +
				row.mediumAct + delimiter +
				row.highAct + delimiter + 
				row.weightKg.toLocaleString(CSV_LOCALE) + delimiter +
				weightTime + delimiter +
				row.weightBmi.toLocaleString(CSV_LOCALE) + delimiter +
				sleepStartTime + delimiter +
				row.MinutesToFallAsleep + delimiter +
				row.AwakeningCount + delimiter +
				row.AwakeCount + delimiter +
				row.MinutesAwake + delimiter +
				row.MinutesRestless + delimiter +
				row.DurationMs + delimiter +				
				row.RestlessCount + delimiter +
				row.MinutesToAwake + delimiter +
				row.MinutesAfterWakeup + delimiter +
				row.Efficiency.toLocaleString(CSV_LOCALE)
			);
		}
	}, 
	function() {
		deferred.resolve();
	});
	
	return deferred.promise;
}



// ----------------------------------------------------------------------------
// Misc functions

function ask(question, format, deferred) {
    if(typeof(deferred) === 'undefined') 
		deferred = Q.defer();
	
	var stdin = process.stdin
	var stdout = process.stdout;

	stdin.resume();
	//process.stdin.setEncoding('utf8');
	stdout.write(question + ": ");

	stdin.once('data', function(data) {
		data = data.toString().trim();
		if(format.test(data)) {
			deferred.resolve(data);
		}
		else {
			stdout.write(("It should match: " + format + "\n").red);
			ask(question, format, deferred);
		}
	});
	
	return deferred.promise;
}

function checkDate(dateString, message) {
	var date = moment(dateString, 'YYYYMMDD');
	if(!date.isValid()) {
		log(LOG_ERROR, true, 'Bad ' + message +' specified (' + dateString + ')');
		return null;
	}
	else
		return date;
}

function showProgress(prompt, start) {
	if(start)
		progress_tick = 0;
	if(progress_tick >= PROGRESS_CHARS.length)
		progress_tick = 0;
	if(typeof(prompt) !== 'undefined')
		progress_prompt = prompt;
	//process.stdout.write(PROGRESS_CHARS[progress_tick++] + '\r');
	var m = progress_prompt + ' [' + PROGRESS_CHARS[progress_tick++].cyan + ']';
	log(LOG_INFO, true, m, undefined, 2);
}

function hideProgress() {
	log(LOG_INFO, false, 
		'                                                                                ', 
		undefined, 2);
	progress_tick = null;
}

function log(severity, logTime, message, object, eolMode) {
	var ts = '';
	var w;
	var eol;

	if(options.quiet)
		return;
		
	switch(eolMode) {
		case 1:
			eol = '';
			break;
		case 2:
			eol = (process.platform == 'win32' || process.platform == 'win64' ?
					'\u001B[0G' : '\r');
			break;
		default:
			eol = os.EOL;
			break;
	}
	
	if(logTime === true) {
		var now = new Date();
		ts = sprintf(' %04d%02d%02d %02d%02d.%-4d', 
			now.getFullYear(),
			now.getMonth() + 1,
			now.getDate(),
			now.getHours(),
			now.getMinutes(),
			now.getSeconds(),
			now.getMilliseconds());
	}	

	switch(severity) {
		case LOG_DEBUG:
			if(options.verbose) {
				w = '[DBG' + ts + '] ';
				process.stdout.write(w.grey + message + eol);
			}
			break;
		case LOG_OK:
			w = '[OK ' + ts + '] ';
			process.stdout.write(w.green + message + eol);
			break;
		case LOG_WARNING:
			w = '[WRN' + ts + '] ';
			process.stdout.write(w.yellow + message + eol);
			break;
		case LOG_ERROR:
			w = '[ERR' + ts + '] ';
			process.stdout.write(w.red + message + eol);
			break;
		default:
			w = '[INF' + ts + '] ';
			process.stdout.write(w.white + message + eol);
			break;
	}
		
	if(typeof(object) !== 'undefined')
		if(severity > 3 || options.verbose) {
			console.log(util.inspect(object, { showHidden: true, depth: 5, colors: true }));
		}
}
