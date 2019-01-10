const inquirer = require("inquirer");
const request = require("request");
const fs = require('fs');
const Q = require("q");

const VALIDATE_IMPORT_UPDATE = "metadata.json?dryRun=true&importMode=VALIDATE&identifier=UID&importStrategy=UPDATE&mergeMode=REPLACE";
const IMPORT_UPDATE = "metadata.json?importMode=COMMIT&identifier=UID&importStrategy=UPDATE&mergeMode=REPLACE";

chooseOperation();

async function chooseOperation() {
	var initialInput = [
		{
			type: "list",
			name: "operation",
			message: "Choose operation",
			choices: ["1. Update property on server based on metadata file"]
		}
	];

	let {operation} = await inquirer.prompt(initialInput);
		

	switch (operation.charAt(0)) {
	case "1":
		patchServerFromFile();
		break;
	default:
		console.log("Not implemented");
	}
}


/** PATCH SERVER BASED ON FILE */
async function patchServerFromFile() {
	let remoteServer = await serverLogin();
	if (!remoteServer) {
		chooseOperation();
		return;
	}

	let {fileContent, filePath} = await requestFile(["json"]);
	console.log(filePath);

	let metadataType = await chooseMetadataType(fileContent);
	while (metadataType) {
		
		let properties = await chooseProperties(fileContent, metadataType);
		let identifier = await chooseIdentifier(fileContent, metadataType);
		if (!properties || !identifier) continue;
		properties.push(identifier);

		//Fetch current values
		let currentValues = (await d2Get(metadataType + "?fields=id" + properties.join(","), remoteServer))[metadataType];
	
		//Prepare list of patches to apply, and get the full metadata to be patched
		let patchList = patchMakeList(fileContent[metadataType], currentValues, properties, identifier, metadataType);
		

		if (patchList.length > 0) {
			let patchData = await patchFetchFullObjects(patchList, remoteServer);
			patchApplyToMetadata(patchData, patchList);
			await patchPushWithPost(patchData, remoteServer);
		}
		metadataType = await chooseMetadataType(fileContent);
	}

	chooseOperation();
}


/** METADATA PATCH FUNCTIONS */
function patchMakeList(referenceValues, currentValues, properties, identifier, metadataType) {
	let patch, needsPatch, patchList = [];
	for (let refObj of referenceValues) {
		let curObj = find(currentValues, refObj.id);
		if (!curObj) continue;
		
		needsPatch = false, patch = {
			"id": refObj.id,
			"metadataType": metadataType,
			"newValues": {} 
		};
		
		//Compare
		for (let prop of properties) {
			if (prop == identifier) continue;
			if (compareMetadataObjects(refObj, curObj, prop)) {
				needsPatch = true;
				patch.newValues[prop] = refObj[prop];
			}
		}

		if (needsPatch) patchList.push(patch);
	}
	return patchList;
}

async function patchFetchFullObjects(patchList, serverInfo) {
	let metadataToFetch = {};
	for (let patch of patchList) {
		if (!metadataToFetch.hasOwnProperty(patch.metadataType)) {
			metadataToFetch[patch.metadataType] = [];
		}
		metadataToFetch[patch.metadataType].push(patch.id);
	}

	let metadata = {};
	for (let type in metadataToFetch) {
		let url = type + ".json?fields=:owner&filter=id:in:[" + metadataToFetch[type].join(",") + "]";
		let data = await d2Get(url, serverInfo);
		metadata[type] = data[type];
	}

	return metadata;
}

function patchApplyToMetadata(metadata, patchList) {
	for (let patch of patchList) {
		for (let obj of metadata[patch.metadataType]) {
			if (patch.id == obj.id) {
				for (let prop in patch.newValues) {
					obj[prop] = patch.newValues[prop];
				}
				break;
			}
		}
	}
}

async function patchPushWithPost(metadata, serverInfo) {
	try {
		let {status, stats} = await d2Post(VALIDATE_IMPORT_UPDATE, metadata, serverInfo);
		if (status == "OK" && stats.updated == stats.total) {
			try {
				let result = await d2Post(IMPORT_UPDATE, metadata, serverInfo);
				if (result.status == "OK" && result.stats.updated == result.stats.total) {
					console.log("Patches applied successfully");
					return true;
				}
				else {
					console.log("Problem applying patches");
					console.log(result);
				}
			} 
			catch (error) {
				console.log("Failed to import patches.");
				console.log(error);
				return false;
			}
		}
		else {
			console.log("Validation failed - cannot apply patches");
			return false;
		}
	}
	catch (error) {
		console.log("Failed to validate patches.");
		console.log(error);
		return;
	}
	
	
}

async function patchPushWithPatch(patchList, patchErrors, serverInfo) {
	let patch = patchList.pop();
	if (!patch) return patchErrors;

	process.stdout.write("*");

	try {
		await d2Patch(patch.metadataType + "/" + patch.id, patch.newValues, serverInfo);
	} 
	catch (error) {
		patchErrors.push(patch);
	}

	return patchPushWithPatch(patchList, patchErrors, serverInfo);
}


/** METADATA UTILS */
function compareMetadataObjects(reference, toCheck, property) {
	let refValue = reference[property], curValue = toCheck[property];

	//Neither have value => no update
	if (!refValue && !curValue) return false;

	//One has value, but not other => update
	if ((!refValue && curValue) || (refValue && !curValue)) return true;

	//One value is primitive, but not other => update
	if (primitive(refValue) != primitive(curValue)) return true;

	//Both are primitive
	if (primitive(refValue) && primitive(curValue)) {
		return (refValue == curValue);
	}
	
	//Both are objects
	if (array(refValue)) {
		if (!array(curValue)) return true;
		if (refValue.length != curValue.length) return true;
		if ((refValue.lenght == 0) && (curValue.lenght == 0)) return false;
		
		//TODO: more advanced checks
		return true;

	}
	else {
		if (Object.keys(refValue).sort().join("") != Object.keys(refValue).sort().join("")) return true;
		if (JSON.stringify(refValue) == JSON.stringify(curValue)) {
			console.log("Same!");
			return false;
		}

		//TODO: more advanced checks
		return true;
	}
}


/** GENERAL PROMPTS */
async function chooseProperties(metadata, type) {
	let choices = Object.keys(metadata[type][0]);
	choices.push("[Cancel]");

	let input = [
		{
			"type": "checkbox",
			"name": "properties",
			"message": "Property/-ies to patch for " + type,
			"choices": choices,
			"pageSize": 15,
			"validate": (answers) => {
				console.log(answers);
				return true;
			}
		}
	]
	let {properties} = await inquirer.prompt(input);

	if (properties.join("").indexOf("[Cancel]") > 0) return false;
	else return properties;
}

async function chooseIdentifier(metadata, type) {
	let choices = Object.keys(metadata[type][0]);
	choices.push("[Cancel]");

	let input = [
		{
			"type": "list",
			"name": "identifier",
			"message": "Property/-ies to patch for " + type,
			"choices": ["code", "id", "[Cancel]"],
			"validate": (answers) => {
				console.log(answers);
				return true;
			}
		}
	]
	let {identifier} = await inquirer.prompt(input);

	if (identifier == "[Cancel]") return false;
	else return identifier;
}

async function chooseMetadataType(metadata) {
	let choices = Object.keys(metadata);
	choices.push("[Cancel]");;
	let input = [
		{
			"type": "list",
			"name": "metadataType",
			"message": "Type of metadata object",
			"choices": choices,
			"validate": (answers) => {
				console.log(answers);
				if (Array.isArray(metadata[answers.metadataType])) {
					console.log("Not patchable");
					return false;
				}
				else return true;
			},
			"when": (answers) => { 
				if (choices.length == 1) {
					answers.metadataType = choices[0];
					return false;
				}
				else return true;
			}
		}
	]
	let {metadataType} = await inquirer.prompt(input);

	if (metadataType == "[Cancel]") return false;
	else return metadataType;
}


/** FILE OPERATIONS */
async function requestFile(fileTypes) {
	let input = [
		{
			"type": "input",
			"name": "path",
			"message": "Path to file",
			"default": "./examples/metadata.json",
			"validate": (path) => { return fs.existsSync(path) ? true : "File not found"; } 
		},
		{
			"type": "list",
			"name": "type",
			"message": "File type",
			"choices": fileTypes,
			"default": fileTypes[0],
			"when": (answers) => {
				if (fileTypes.length == 1) {
					answers.type == fileTypes[0];
					return false;
				}
				else return true;
			}
		}
	];
	let {path, type} = await inquirer.prompt(input);
	let data;
	if (fileTypes.length == 1) type = fileTypes[0];
	switch (type) {
		case "json":
			data = readJsonFile(path);
			break;
		case "csv": 
			data = readCsvFile(path);
			break;
		default:
			console.log("File type not supported: " + type);
	}

	return {"fileContent": data, "filePath": path, "fileType": type};
}

function postFixFilePath(filePath, postfix) {
	//TODO: support for non-json files
	return filePath.replace(".json", "_" + postfix + ".json");
}

function readJsonFile(filePath) {
	let fileContent = fs.readFileSync(filePath);
	let metadata;
	try {
		metadata = JSON.parse(fileContent);
	} catch (error) {
		console.log("Problem parsing JSON:");
		console.log(error);
		return false;
	}
	return metadata;
}

function readCsvFile(filePath) {
	//TODO - windows line breaks
	let fileContent = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    let attributes = {};
    
    var lineNumber = 0, invalidFile = true;
    for (let line of fileContent) {
        if (lineNumber++ > 0) {
            let ids = line.split(",");
            if (ids.length != 2 || ids[0].length != 11 || ids[1].length != 11) {
                console.log("Line " + lineNumber + " has invalid format");
            }
            else {
                invalidFile = false;
                attributes[ids[0]] = ids[1];
            }
        }
    }
	
	return invalidFile ? false : attributes;
}

function saveFile(filePath, content, type) {
	//TODO - other types
	if (type != "json") return false;
	try {
		fs.writeFileSync(filePath, JSON.stringify(content, null, 4));
		console.log("Metadata saved to " + filePath);
	} catch (error) {
		console.log("Error saving metadata file.");
		console.log(error);
	}
}

/** SERVER COMMUNICATION */
async function serverLogin() {
	let input = [
		{
			"type": "input",
			"name": "url",
			"message": "URL",
			"default": "https://play.dhis2.org/2.28"
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

	let serverInfo = await inquirer.prompt(input);
	let success = await testConnection(serverInfo);
	if (success) return serverInfo;
	else return false;

}

async function testConnection(serverInfo) {
	try {
		let data = await d2Get("system/info.json", serverInfo);
		
		serverInfo.version = data.version;
		serverInfo.name = data.systemName;

		console.log("Connected to " + serverInfo.name + ", DHIS2 " + serverInfo.version);
		
		return true;
	} 
	catch (error) {
		if (JSON.stringify(error).indexOf("Bad credentials") > 0) {
			console.log("Wrong username/password")
		}
		else if (JSON.stringify(error).indexOf("Invalid URI") > 0) {
			console.log("Problem with URL - did you remember http/https?");
		}
		else if (JSON.stringify(error).indexOf("404 Not Found") > 0 ||
				JSON.stringify(error).indexOf("ECONNREFUSED") > 0) {
			console.log("Problem with URL - server not found or running.");
		}
		else {
			console.log(error);
		}
		return false;
	}
}

function d2Get(apiResource, serverInfo) {
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
			deferred.reject({'data': data, 'error': error, 'status': response});
		}
	});

	return deferred.promise;
}

function d2Post(apiResource, data, serverInfo) {
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

function d2Patch(apiResource, data, serverInfo) {
	var deferred = Q.defer();
	var url = serverInfo.url + "/api/" + apiResource;


	request.patch({
		uri: url,
		json: true,
		body: data,
		auth: {
			"user": serverInfo.username,
			"pass": serverInfo.password
		}
	}, function (error, response, data) {
		if (!error && response.statusCode.toString().charAt(0) == "2") {
			deferred.resolve(data);
		}
		else {
			console.log("Error in PATCH");
			console.log(data);
			deferred.reject({"data": data, "error": error, "status": response.statusCode});
		}
	});

	return deferred.promise;
}


/** UTILITIES */
function find(metadataArray, id) {
	for (let obj of metadataArray) {
		if (obj.id == id) return obj;
	}
	return false;
}

function primitive(toTest) {
    return (toTest !== Object(toTest));
}

function array(toTest) {
	return Array.isArray(toTest);
}