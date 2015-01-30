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

var util = require('util'),
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
var start_date;
var end_date;
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

var xreq = {
	cookies: {},
	url: 'http://dummy'
};

var xres = {
	cookie: function(name, value) {
		log(LOG_DEBUG, 'res:cookie(' + name + ')', value);
		xreq.cookies[name] = value;
	},

	redirect: function(redirectToUrl) {
		log(LOG_DEBUG, 'res:redirect', redirectToUrl);
		xreq.url = redirectToUrl;

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
					log(LOG_ERROR, 'Error starting user web browser', error);
					doExit(error);
				}
			});

			// ask user for pin from fitbit registration
			ask("PIN", /.+/, function(pin) {
				console.log();
				oauth_verifier = pin;

				// build new url to access token
				pu.search = null;
				pu.query.oauth_verifier = pin;
				xreq.url = url.format(pu);

				requestToken(doExit);
			});
		}
	}
};



// ----------------------------------------------------------------------------
// Main part

//process.stdin.setEncoding('utf8');

log(LOG_INFO, 'FitBit Dumper, Version ' + VERSION);
log(LOG_DEBUG, 'FitBit client, Version ' + fitbitClient.version);

var now = moment();
end_date = now.clone();
start_date = now.clone();
start_date.subtract(DEFAULT_DAYS, 'days');

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

main();

function main() {
	// check if FitBitDump already authorized
	fs.exists('./fitbit.oauth', function(exists) {
		if(options.register) {
			requestToken(doExit);
		}
		else if(options.dbinit) {
			createDatabase(doExit);
		}
		else if(options.dbdump)
			dumpDatabase(doExit);
		else
			if(exists)
				doWork(doExit);
			else {
				log(LOG_WARNING, 'OAuth token not available, start registering',
					fitbitClient);
				requestToken(doExit);
			}
	});
}

function doWork(callback) {
	log(LOG_INFO, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
		
	fs.readFile("./fitbit.oauth", 'utf8', function(error, data) {
		if(error) {
			log(LOG_ERROR, 'Invalid local OAuth token format. ' +
				'Use -r to initialize.', error);
			doExit(error);
		}

		if(!error && data) {
			master_token = JSON.parse(data);
			log(LOG_OK, 'Using FitBit API with local OAuth tokens', master_token);

			// get data for each day from fitbit
			var date = start_date.clone();
			var cnt = days_to_dump;
			do {
				requestData(date.clone());
				date.add(1, 'days');
				cnt--;
			} while(cnt > 0);
//console.log('######');
		}
	});
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

function requestToken(callback) {
	// request an app token/pin
	log(LOG_INFO, 'Requesting FitBit OAuth token ...');

	fitbitClient.getAccessToken(xreq, xres, function (error, newToken) {
		if(error) {
			log(LOG_ERROR, 'Error requesting OAuth token', error);
			if(callback)
				callback(error);
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
							if(error)
								log(LOG_ERROR, 'Invalid OAuth token format', error);
							else
								log(LOG_OK, 'FitBit OAuth credentials saved');

							if(callback)
								callback(error);
						});
			}
		}
	});
}

function requestData(date, callback) {
	//log(LOG_INFO, 'Calling FitBit data API ...');
	
	// https://wiki.fitbit.com/display/API/API-Get-Activities
	var actUrl = '/user/-/activities/date/' + date.format('YYYY-MM-DD') + '.json';
	fitbitClient.apiCall('GET', actUrl,
		{ token: master_token },
		function(error, res, activities) {
			if(error) {
				if(!options.verbose)
					process.stdout.write('A'.red);
				else
					log(LOG_ERROR, 'API error, url=' + actUrl, error);
				if(callback)
					callback(error);
			}
			else {
				// A - activities
				if(!options.verbose)
					process.stdout.write('A'.green);
//console.log('----------');
//console.log(util.inspect(activities, { showHidden: true, depth: null, colors: true }));
//console.log('----------');
				// https://wiki.fitbit.com/display/API/API-Get-Body-Weight
				var weightUrl = '/user/-/body/log/weight/date/' + date.format('YYYY-MM-DD') + '.json';
				fitbitClient.apiCall('GET', weightUrl,
					{ token: master_token },
					function(error, res, weight) {
						if(error) {
							if(!options.verbose)
								process.stdout.write('W'.red);
							else
								log(LOG_ERROR, 'API error, url=' + weightUrl, error);
							if(callback)
								callback(error);
						}
						else {
							// W - weight
							if(!options.verbose)
								process.stdout.write('W'.green);
//console.log('----------');
//console.log(util.inspect(weight, { showHidden: true, depth: null, colors: true }));
//console.log('----------');

							// https://wiki.fitbit.com/display/API/API-Get-Sleep
							var sleepUrl = '/user/-/sleep/date/' + date.format('YYYY-MM-DD') + '.json';
							fitbitClient.apiCall('GET', sleepUrl,
								{ token: master_token },
								function(error, res, sleep) {
									if(error) {
										if(!options.verbose)
											process.stdout.write('S'.red);
										else
											log(LOG_ERROR, 'API error, url=' + sleepUrl, error);
										if(callback)
											callback(error);
									}
									else {
										// S - sleep
										if(!options.verbose)
											process.stdout.write('S'.green);
//console.log('----------');
//console.log(util.inspect(sleep, { showHidden: true, depth: null, colors: true }));
//console.log('----------');
										saveFitBitRecord(date, activities, weight, sleep, callback);
									}
								});
						}
					});
			}
		});
}



// ----------------------------------------------------------------------------
// Database functions

function createDatabase(callback) {
	log(LOG_INFO, 'Initializing database');

	db.serialize(function() {
		db.run('DROP TABLE IF EXISTS data', function(error) {
			if(error) {
				log(LOG_ERROR, 'Error droping data table', error);

				if(callback)
					callback(error);
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
					'weight FLOAT NOT NULL DEFAULT 0.0)', function(error) {
						if(error)
							log(LOG_ERROR, 'Error creating data table', error);
						else {
							db.run('CREATE UNIQUE INDEX data_date ON ' +
								'data(date);', function(error) {
									if(error)
										log(LOG_ERROR, 'Error creating data table index', error);
									else
										log(LOG_OK, 'Database successfully initialized');
									
									if(callback)
										callback(error);
								});								
						}
					});
		});
    });
}

function saveFitBitRecord(date, activities, weight, sleep, callback) {
	log(LOG_DEBUG, 'Save FitBit data to database ' + date.format('YYYY-MM-DD'));

	db.serialize(function() {
		var w = 0.0;
		if(weight.weight && weight.weight.length > 0) {
			w = weight.weight[0].weight;
		}
	
		db.run("INSERT OR IGNORE INTO data VALUES (" +
			"(date('" + date.format('YYYY-MM-DD') + "')), " +
			activities.summary.steps + ', ' + activities.summary.floors + ', ' +
			activities.summary.caloriesOut + ', ' + activities.summary.fairlyActiveMinutes + ', ' +
			activities.summary.lightlyActiveMinutes + ', ' + activities.summary.veryActiveMinutes + ', ' +
			w + ')',
			function(error) {
				if(error) {
					// D = DB Write
					if(!options.verbose)
						process.stdout.write('D'.red);
					else
						log(LOG_ERROR, 'Error writing database', error);
				}
				else {
					if(!options.verbose)
						process.stdout.write('D'.green);
					else
						log(LOG_DEBUG, 'FitBit data successfully saved');
				}

				if(callback)
					callback(error);
			});
	});
}

function dumpDatabase(callback) {
	log(LOG_INFO, 'Dump FitBit records');
	log(LOG_INFO, 'Start: ' + start_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', End: ' + end_date.format(DISPLAY_DATE_FORMAT).cyan + 
		', Days: ' + days_to_dump.toString().cyan);
	
	db.each('SELECT rowid AS id, * ' +
			'FROM data ORDER BY date ASC', function(error, row) {
		if(error) {
			log(LOG_ERROR, 'Error reading database', error);
			if(callback)
				callback(error);
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
	}, callback);
}



// ----------------------------------------------------------------------------
// Misc functions

function ask(question, format, callback) {
	var stdin = process.stdin
	var stdout = process.stdout;

	stdin.resume();
	//process.stdin.setEncoding('utf8');
	stdout.write(question + ": ");

	stdin.once('data', function(data) {
		data = data.toString().trim();
		if(format.test(data)) {
			if(callback)
				callback(data);
		}
		else {
			stdout.write("It should match: "+ format +"\n");
			ask(question, format, callback);
		}
	});
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
			console.log('[ERR] '.red + message);
			break;
		default:
			console.log('[INF] '.white + message);
			break;
	}

	if(object)
		if(severity > 3 || options.verbose)
			console.log(object);
}
