const inquirer = require("inquirer");
const request = require("request");
const fs = require('fs');

var serverInfo = {
	"url": null,
	"username": null,
	"password": null	
};

start();

function start() {
	var initialInput = [
		{
			"type": "input",
			"name": "url",
			"message": "URL of target/receiving server",
			"default": "http://localhost:9090/demo"
		},
		{
			"type": "input",
			"name": "username",
			"message": "Username",
			"default": "admin"
		},
		{
			"type": "password",
			"name": "password",
			"message": "Password",
			"default": "district"
		}
	];

	inquirer.prompt(initialInput).then(answers => {
		serverInfo.url = answers.url;
		serverInfo.username = answers.username;
		serverInfo.password = answers.password;
		
		chooseOperation();
	});
}


async function chooseOperation() {
	var initialInput = [
		{
			type: "list",
			name: "type",
			message: "Metadata type to de-duplicate",
			choices: ["categoryOptions", "categories", "categoryCombos"]
		}
	];

	inquirer.prompt(initialInput).then(answers => {
		metadata = {}, metadataDelete = {}, metadataFinal = {};

		switch (answers.type) {
		case "categoryOptions":
			categoryOptions();
			break;
		case "categories":
			categories();
			break;
		case "categoryCombos":
			categoryCombos();
			break;
		default:
			console.log("Not implemented");
		}

	});
}


function d2Get(apiResource) {
	var deferred = Q.defer();

	var url = serverInfo.url + "/api/" + apiResource;
	if (url.indexOf("?") >= 0) url += "&paging=false";
	else url += "?paging=false";

	request.get({
		uri: url,
		json: true,
		auth: {
			"user": serverInfo.username,
			"pass": serverInfo.password
		}
	}, function (error, response, data) {
		if (!error && response.statusCode === 200) {
			deferred.resolve(data);
		}
		else {
			console.log("Error in GET");
			console.log(error.message);
			deferred.reject({'data': data, 'error': error, 'status': response});
		}
	});

	return deferred.promise;
}

function d2Post(apiResource, data) {
	var deferred = Q.defer();
	var url = serverInfo.url + "/api/" + apiResource;

	request.post({
		uri: url,
		json: true,
		body: data,
		auth: {
			"user": serverInfo.username,
			"pass": serverInfo.password
		}
	}, function (error, response, data) {
		if (!error && response.statusCode === 200) {
			deferred.resolve(data);
		}
		else {
			console.log("Error in POST");
			console.log(data);
			deferred.reject({"data": data, "error": error, "status": response.statusCode});
		}
	});

	return deferred.promise;
}