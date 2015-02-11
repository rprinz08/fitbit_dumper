/*
	https://wiki.fitbit.com/display/API/Fitbit+API

	keys at: https://dev.fitbit.com/apps/details/22988D

	Consumer key
	2fb466d29ca149799037a6a263ba0bfc

	Consumer secret
	91f273d309e746119b4f0f9303363cb7

	Request token URL
	http://api.fitbit.com/oauth/request_token

	Access token URL
	http://api.fitbit.com/oauth/access_token

	Authorize URL
	http://www.fitbit.com/oauth/authorize
*/

var Q = require('q'),
	util = require('util'),
	fs = require('fs'),
	printf = require('printf'),
	colors = require('colors'),
	url = require('url'),
	spawn = require('open'),
	stdio = require('stdio'),
	moment = require('moment'),
	sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('./fitbit.db');

var fb_consumer_key = '2fb466d29ca149799037a6a263ba0bfc';
var fb_consumer_sec = '91f273d309e746119b4f0f9303363cb7';
var fitbitClient = require('fitbit-js')
		(fb_consumer_key, fb_consumer_sec, 'http://dummy');

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
var DEFAULT_DAYS = 13;
var now = moment();
var start_date = now.clone();
var end_date = now.clone();
start_date.subtract(DEFAULT_DAYS, 'days');
var days_to_dump;

// command line options
var options = stdio.getopt({
	'start': { key: 's', description: 'Start date ' + DATE_FORMAT, args: 1 },
	'end': { key: 'e', description: 'End date ' + DATE_FORMAT, args: 1 },
	'verbose': { key: 'v', description: 'Verbose debug output' },
	'dbinit': { key: 'i', description: 'Initialize database' },
	'dbdump': { key: 'd', description: 'Dump out database as CSV' },
	'register': { key: 'r', description: 'Register with FitBit' }
});



// ----------------------------------------------------------------------------
// Fake some objects to mimic express for command line usage

var fakeRequest = {
	cookies: {},
	url: 'http://dummy'
};

var fakeResponse = {
	cookie: function(name, value) {
		log(LOG_DEBUG, 'res:cookie(' + name + ')', value);
		
		fakeRequest.cookies[name] = value;
	},

	redirect: function(redirectToUrl) {
		log(LOG_DEBUG, 'res:redirect', redirectToUrl);
		
		fakeRequest.url = redirectToUrl;

		if (redirectToUrl.substring(0, 51) == "https://www.fitbit.com/oauth/authorize?oauth_token=") {
			var pu = url.parse(redirectToUrl, true);
			oauth_token = pu.query.oauth_token;
			log(LOG_DEBUG, 'oauth_token', oauth_token);

			console.log('\r\n\r\Use your browser to open this URL:\r\n');
			console.log(redirectToUrl.cyan);
			console.log('\r\nThen come back and enter the PIN here\r\n');

			// start user browser for fitbit registration
			spawn(redirectToUrl, function(error) {
				if(error) {
					log(LOG_ERROR, 'Error starting user web browser');
					doExit(error);
				}
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

main();

//process.stdin.setEncoding('utf8');

function main() {
	log(LOG_INFO, 'FitBit Dumper, Version ' + VERSION);
	log(LOG_DEBUG, 'FitBit client, Version ' + fitbitClient.version);

	if(options.register) {
		requestToken()
			.then(doExit)
			.fail(doExit);		
		return;
	}
	
	if(options.dbinit) {
		createDatabase()
			.then(doExit)
			.fail(doExit);		
		return;
	}
	
	if(options.start) {
		start_date = checkDate(options.start, 'start date');
		if(!start_date)
			doExit(true);
		if(!options.end)
			end_date = start_date.clone().add(DEFAULT_DAYS, 'days');
	}

	if(options.end) {
		end_date = checkDate(options.end, 'end date');
		if(!end_date)
			doExit(true);
		if(!options.start)
			start_date = end_date.clone().subtract(DEFAULT_DAYS, 'days');
	}

	if(start_date > end_date) {
		var tmp = start_date;
		start_date = end_date;
		end_date = tmp;
	}

	days_to_dump = end_date.diff(start_date, 'days') + 1;

	if(options.dbdump) {
		dumpDatabase()
			.then(doExit)
			.fail(doExit);
		return;
	}
	
	// check if FitBitDump already authorized
	fs.exists('./fitbit.oauth', function(exists) {
		if(exists)
			doWork()
				.then(doExit)
				.fail(doExit);
		else {
			log(LOG_WARNING, 'OAuth token not available, start registering',
				fitbitClient.version);
			log(LOG_WARNING, 'If this is the first time use this software you have');
			log(LOG_WARNING, 'to register it with your FitBit account.');
			requestToken()
				.then(doExit)
				.fail(doExit);		
		}
	});
}

function doWork() {
	var deferred = Q.defer();
	
	log(LOG_INFO, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
		
	fs.readFile("./fitbit.oauth", 'utf8', function(error, data) {
		if(error) {
			log(LOG_ERROR, 'Invalid local OAuth token format. ' +
				'Use -r to initialize.');
			deferred.reject(new Error(error));
		}

		if(!error && data) {
			var queue = [];
			master_token = JSON.parse(data);
			log(LOG_OK, 'Using FitBit API with local OAuth tokens', master_token);

			// get data for each day from fitbit
			var date = start_date.clone();
			var cnt = days_to_dump;
			do {
				queue.push(requestData(date.clone()));
				date.add(1, 'days');
				cnt--;
			} while(cnt > 0);
			
			Q.all(queue)
				.then(function(result) {
					deferred.resolve();
				})
				.fail(function(error) {
					deferred.reject(new Error(error));
				});
		}
	});
	
	return deferred.promise;
}

function doExit(error) {
	if(error)
		log(LOG_ERROR, 'FitBit dumper completed with errors'.red, error);
	else
		log(LOG_OK, 'FitBit dumper completed');
	db.close();
	process.exit();
}



// ----------------------------------------------------------------------------
// FitBit functions

function requestToken() {
	var deferred = Q.defer();
	
	// request an app token/pin
	log(LOG_INFO, 'Requesting FitBit OAuth token ...');

	fitbitClient.getAccessToken(fakeRequest, fakeResponse, function (error, newToken) {
		if(error) {
			log(LOG_ERROR, 'Error requesting OAuth token');
			deferred.reject(new Error(error));
		}
		else {
//console.log('----------');
//console.log(util.inspect(newToken, { showHidden: true, depth: null, colors: true }));
//console.log('----------');
			if(newToken) {
				master_token = newToken;
				log(LOG_OK, 'New OAuth token available', master_token);

				// save oauth token
				fs.writeFile('./fitbit.oauth', 
					JSON.stringify(newToken, null, 4), 
					function(error) {
						if(error) {
							log(LOG_ERROR, 'Invalid OAuth token format');
							deferred.reject(new Error(error));
						}
						else
							log(LOG_OK, 'FitBit OAuth credentials saved');
							
						deferred.resolve();
					});
			}
		}
	});
	
	return deferred.promise;
}

function requestData(date) {
	//log(LOG_INFO, 'Calling FitBit data API ...');
	
	var queue = [];
	
	// https://wiki.fitbit.com/display/API/API-Get-Activities
	var actUrl = '/user/-/activities/date/' + date.format('YYYY-MM-DD') + '.json';
	// https://wiki.fitbit.com/display/API/API-Get-Body-Weight
	var weightUrl = '/user/-/body/log/weight/date/' + date.format('YYYY-MM-DD') + '.json';
	// https://wiki.fitbit.com/display/API/API-Get-Sleep
	var sleepUrl = '/user/-/sleep/date/' + date.format('YYYY-MM-DD') + '.json';
	
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
	
	fitbitClient.apiCall(
		method, 
		url,
		{ token: master_token },
		function(error, res, activities) {
			if(error)
				deferred.reject(new Error(error));
			else
				deferred.resolve(activities);
		});
	
	return deferred.promise;
}



// ----------------------------------------------------------------------------
// Database functions

function createDatabase() {
	var deferred = Q.defer();
	
	log(LOG_INFO, 'Initializing database');

	db.serialize(function() {
		db.run('DROP TABLE IF EXISTS data', function(error) {
			if(error) {
				log(LOG_ERROR, 'Error droping data table');
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
							log(LOG_ERROR, 'Error creating data table');
							deferred.reject(new Error(error));
						}
						else {
							db.run('CREATE UNIQUE INDEX data_date ON ' +
								'data(date);', function(error) {
									if(error) {
										log(LOG_ERROR, 'Error creating data table index', error);
										deferred.reject(new Error(error));
									}
									else {
										log(LOG_OK, 'Database successfully initialized');
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
	
	log(LOG_DEBUG, 'Save FitBit data to database ' + date.format('YYYY-MM-DD'));

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
		
		var sql = "INSERT INTO data VALUES (" +
			"\r\n" + 
			"(date('" + date.format('YYYY-MM-DD') + "')), " +
			activities.summary.steps + ', ' + activities.summary.floors + ', ' +
			activities.summary.caloriesOut + ', ' + activities.summary.fairlyActiveMinutes + ', ' +
			activities.summary.lightlyActiveMinutes + ', ' + activities.summary.veryActiveMinutes + ', ' +
			"\r\n" + 
			weightKg + ', ' + weightTime + ', ' + weightBmi + ', ' +
			"\r\n" + 
			sleepStartTime + ', ' + MinutesToFallAsleep + ', ' + AwakeningCount + ', ' +
			AwakeCount + ', ' + MinutesAwake + ', ' + MinutesRestless + ', ' + DurationMs + ', ' +
			RestlessCount + ', ' + MinutesToAwake + ', ' + MinutesAfterWakeup + ', ' + 
			Efficiency +
			')';
		log(LOG_DEBUG, 'SQL insert statement', sql);
			
		db.run(sql,
			function(error) {
				if(error) {
					// D = DB Write
					if(!options.verbose)
						process.stdout.write('D'.red);
					else
						log(LOG_ERROR, 'Error writing database', error);
					deferred.reject(new Error(error));
				}
				else {
					if(!options.verbose)
						process.stdout.write('D'.green);
					else
						log(LOG_DEBUG, 'FitBit data successfully saved');
					deferred.resolve();
				}
			});
	});
	
	return deferred.promise;
}

function dumpDatabase() {
	var deferred = Q.defer();
	
	log(LOG_INFO, 'Dump FitBit records');
	log(LOG_INFO, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
	
	db.each('SELECT rowid AS id, * ' +
			'FROM data ORDER BY date ASC', function(error, row) {
		if(error) {
			log(LOG_ERROR, 'Error reading database', error);
			deferred.reject(new Error(error));
		}
		else {
			log(LOG_DEBUG, 'DB record', row);
			console.log(row.id + ',' +
				row.date + ',' +
				row.steps + ',' +
				row.floors + ',' +
				row.burnedCal + ',' +
				row.lightAct + ',' +
				row.mediumAct + ',' +
				row.highAct + ',' + 
				row.weight);
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
			stdout.write("It should match: "+ format +"\n");
			ask(question, format, deferred);
		}
	});
	
	return deferred.promise;
}

function checkDate(dateString, message) {
	var date = moment(dateString, 'YYYYMMDD');
	if(!date.isValid()) {
		log(LOG_ERROR, 'Bad ' + message +' specified (' + dateString + ')');
		return null;
	}
	else
		return date;
}

function log(severity, message, object) {
	switch(severity) {
		case 0:
			if(options.verbose)
				console.log('[DBG] '.grey + message);
			break;
		case 2:
			console.log('[OK ] '.green + message);
			break;
		case 3:
			console.log('[WRN] '.yellow + message);
			break;
		case 4:
			console.log('[ERR] '.red + message.toString().red);
			break;
		default:
			console.log('[INF] '.white + message);
			break;
	}

	if(object)
		if(severity > 3 || options.verbose)
			console.log(util.inspect(object, { showHidden: true, depth: 2, colors: true }));
}
