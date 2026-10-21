/**
 * Client for a DNS management service in front of dnsmasq.
 *
 * dnsmasq only accepts DNS traffic and has no REST CRUD interface.  The
 * configured service must expose conventional REST endpoints at recordsPath:
 * POST /records, GET /records[/id], PUT /records/id and DELETE /records/id.
 */

const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const rest = require(`${CONSTANTS.LIBDIR}/rest.js`);

const DNS_RECORDS_MEMORY_KEY = "__org_monkshu_dns_records";
const conf = utils.loadAndResolveConf(`${CONSTANTS.CONFDIR}/dns.json`);

exports.create = async record => {
    const validRecord = _validateRecord(record, true);
    const response = await _request("post", _recordsPath(), validRecord);
    const savedRecord = _getRecord(response, validRecord);
    await _upsertCachedRecord(savedRecord);
    return savedRecord;
};

exports.get = async id => {
    _validateID(id);
    const response = await _request("get", _recordPath(id));
    const record = _getRecord(response);
    await _upsertCachedRecord(record);
    return record;
};

exports.list = async filter => {
    const response = await _request("get", _pathWithQuery(_recordsPath(), filter));
    const records = _getRecords(response);
    await _replaceCachedRecords(records);
    return records;
};

exports.update = async (id, record) => {
    _validateID(id);
    const validRecord = _validateRecord(record, false);
    const response = await _request("put", _recordPath(id), validRecord);
    const savedRecord = _getRecord(response, {...validRecord, id});
    await _upsertCachedRecord(savedRecord);
    return savedRecord;
};

exports.remove = async id => {
    _validateID(id);
    const response = await _request("delete", _recordPath(id));
    const deletedRecord = _getRecord(response, {id});
    await _removeCachedRecord(id);
    return deletedRecord;
};

async function _request(method, path, body) {
    _validateConfiguration();
    // rest.js exports the HTTP delete function as `delete`, while its HTTPS
    // counterpart retains the explicit `deleteHttps` name.
    const requestMethod = conf.secure ? `${method}Https` : method;
    const headers = {...(conf.headers || {})};
    const call = rest[requestMethod](conf.host, conf.port, path, headers, body, conf.sslOptions);
    const result = await _withTimeout(call, Number(conf.timeout) || 10000);
    if (!result || result.error || result.status < 200 || result.status >= 300) {
        const detail = result?.error || result?.data?.error || `HTTP ${result?.status || "request failed"}`;
        throw new Error(`DNS management service request failed: ${detail}`);
    }
    return result.data;
}

function _withTimeout(promise, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`DNS management service timed out after ${timeout}ms`)), timeout);
        promise.then(result => {clearTimeout(timer); resolve(result);}, error => {clearTimeout(timer); reject(error);});
    });
}

function _validateConfiguration() {
    if (!conf.host || !Number.isInteger(Number(conf.port)) || Number(conf.port) < 1 || Number(conf.port) > 65535)
        throw new Error("Invalid DNS management configuration: host and port are required");
    if (!conf.recordsPath || !String(conf.recordsPath).startsWith("/"))
        throw new Error("Invalid DNS management configuration: recordsPath must begin with '/'");
}

function _validateID(id) {
    if (id === undefined || id === null || String(id).trim() === "") throw new Error("id is required");
}

function _validateRecord(record, isCreate) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("record must be an object");
    const cleanRecord = {};
    for (const [key, value] of Object.entries(record)) if (!["operation", "op", "action", "id", "filter"].includes(key)) cleanRecord[key] = value;

    if (isCreate) for (const property of ["name", "type", "value"])
        if (cleanRecord[property] === undefined || cleanRecord[property] === null || cleanRecord[property] === "")
            throw new Error(`record.${property} is required`);
    if (!isCreate && Object.keys(cleanRecord).length === 0) throw new Error("record must contain at least one field to update");

    if (cleanRecord.name !== undefined && (typeof cleanRecord.name !== "string" || !cleanRecord.name.trim() || cleanRecord.name.length > 253 || /\s/.test(cleanRecord.name)))
        throw new Error("record.name must be a DNS name without whitespace");
    if (cleanRecord.type !== undefined && (typeof cleanRecord.type !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(cleanRecord.type)))
        throw new Error("record.type must be a DNS record type");
    if (cleanRecord.value !== undefined && !["string", "number"].includes(typeof cleanRecord.value))
        throw new Error("record.value must be a string or number");
    if (cleanRecord.ttl !== undefined && (!Number.isInteger(Number(cleanRecord.ttl)) || Number(cleanRecord.ttl) < 0))
        throw new Error("record.ttl must be a non-negative integer");
    return cleanRecord;
}

const _recordsPath = _ => String(conf.recordsPath).replace(/\/$/, "") || "/";
const _recordPath = id => `${_recordsPath()}/${encodeURIComponent(String(id))}`;

function _pathWithQuery(path, filter) {
    if (!filter) return path;
    if (typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter must be an object");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== null) query.set(key, String(value));
    const encoded = query.toString(); return encoded ? `${path}?${encoded}` : path;
}

const _getRecord = (response, fallback) => response?.record || response?.data?.record || response?.data || response || fallback;
const _getRecords = response => {
    const records = response?.records || response?.data?.records || response?.data || response;
    if (!Array.isArray(records)) throw new Error("DNS management service returned an invalid records response");
    return records;
};

async function _getCache() { return await CLUSTER_MEMORY.get(DNS_RECORDS_MEMORY_KEY, {records: []}, true) || {records: []}; }
async function _replaceCachedRecords(records) { CLUSTER_MEMORY.set(DNS_RECORDS_MEMORY_KEY, {records: [...records]}); }
async function _upsertCachedRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const cache = await _getCache(), key = _recordKey(record);
    const index = cache.records.findIndex(item => _recordKey(item) === key);
    if (index === -1) cache.records.push(record); else cache.records[index] = record;
    CLUSTER_MEMORY.set(DNS_RECORDS_MEMORY_KEY, cache);
}
async function _removeCachedRecord(id) {
    const cache = await _getCache(); cache.records = cache.records.filter(record => String(record.id) !== String(id));
    CLUSTER_MEMORY.set(DNS_RECORDS_MEMORY_KEY, cache);
}
const _recordKey = record => record?.id !== undefined ? `id:${record.id}` : `${record?.name || ""}|${record?.type || ""}|${record?.value || ""}`;
