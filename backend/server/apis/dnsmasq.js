/**
 * DNS record CRUD API.
 *
 * The dnsmasq daemon has no HTTP management API of its own.  This endpoint
 * talks to the DNS management service configured in conf/dns.json; that
 * service is responsible for changing dnsmasq's records and reloading it.
 */

const dnsmanager = require(`${CONSTANTS.LIBDIR}/dnsmanager.js`);

exports.doService = async request => {
    const operation = String(request?.operation || request?.op || request?.action || "").toLowerCase();

    try {
        switch (operation) {
            case "create":
            case "add":
                return {result: true, operation: "create", record: await dnsmanager.create(request.record || request)};

            case "read":
            case "get":
                if (request.id !== undefined && request.id !== null && request.id !== "")
                    return {result: true, operation: "read", record: await dnsmanager.get(request.id)};
                return {result: true, operation: "read", records: await dnsmanager.list(request.filter)};

            case "list":
                return {result: true, operation: "list", records: await dnsmanager.list(request.filter)};

            case "update":
            case "edit":
                return {result: true, operation: "update", record: await dnsmanager.update(request.id, request.record || request)};

            case "delete":
            case "remove":
                return {result: true, operation: "delete", record: await dnsmanager.remove(request.id)};

            default:
                return {result: false, error: "operation must be create, read, list, update, or delete"};
        }
    } catch (error) {
        LOG.error(`DNS record ${operation || "unknown"} operation failed: ${error.message || error}`);
        return {result: false, operation: operation || undefined, error: error.message || String(error)};
    }
};
