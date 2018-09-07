"use strict";

const EventEmitter = require('events').EventEmitter;
const Extend = require('util')._extend;
const Request = require('request');
const debug = require('debug')('Node-Arlo');
const debugComm = require('debug')('Arlo:REST');

const Constants = require('./ArloConstants');
const ArloBaseStation = require('./ArloBaseStation');
const ArloCamera = require('./ArloCamera');
const ArloQ = require('./ArloQ');

const HTTP_GET  = 'GET',
      HTTP_POST = 'POST';

class Arlo extends EventEmitter {
    constructor() {
        super();

        this.devices = {};
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_1_2 like Mac OS X) AppleWebKit/604.3.5 (KHTML, like Gecko) Mobile/15B202 NETGEAR/v1 (iOS Vuezone)'
        }
        this.pendingSnapshots = {};
    }

    getDevices(callback) {
        this._get(Constants.WEB.DEVICES, {}, function(error, response, body) {
            if (!body || body.success !== true) {
                return;
            }

            for (let i = 0; i < body.data.length; i++) {
                let device = body.data[i];

                if (device.deviceType === Constants.TYPE_BASESTATION) {
                    this.devices[device.deviceId] = new ArloBaseStation(device, this);
                    this.devices[device.deviceId].subscribe();
                    this.emit(Constants.EVENT_FOUND, this.devices[device.deviceId]);
                }
            }

            for (let i = 0; i < body.data.length; i++) {
                let device = body.data[i];

                if (device.deviceType === Constants.TYPE_CAMERA) {
                    this.devices[device.deviceId] = new ArloCamera(device, this);
                    this.emit(Constants.EVENT_FOUND, this.devices[device.deviceId]);
                }
                else if (device.deviceType === Constants.TYPE_ARLOQS) {
                    this.devices[device.deviceId] = new ArloQ(device, this);
                    this.devices[device.deviceId].subscribe();
                    this.emit(Constants.EVENT_FOUND, this.devices[device.deviceId]);
                }
            }

            this.emit(Constants.EVENT_GOT_DEVICES, this.devices);

            if (typeof(callback) == 'function') {
                callback();
                callback = undefined;
            }
        }.bind(this));
    }

    login(username, password, callback) {
        this._post(
            Constants.WEB.LOGIN,
            {'email': username, 'password': password},
            {},
            function(error, response, body) {
                this.token = body.data.token;
                this.headers = Extend({'Authorization': this.token}, this.headers);

                this.userId = body.data.userId;
                this.emit(Constants.EVENT_LOGGED_IN, body.data.serialNumber);

                this.subscribe(function() {
                    this.getDevices();
                }.bind(this));

                if (typeof(callback) == 'function') {
                    callback();
                    callback = undefined;
                }
            }.bind(this)
        );
    }

    subscribe(callback) {
        let reCamera = /cameras\/(.+)$/;
        let reSubscription = /subscriptions\/(.+)$/;

        Request
            .get({url: Constants.WEB.SUBSCRIBE + '?token=' + this.token, method: HTTP_GET, json: false, jar: true, headers: Extend({'Accept': 'text/event-stream'}, this.headers)})
            .on('data', function(data) {
                let str, msg;
                
                if (typeof(callback) == 'function') {
                    callback();
                    callback = undefined;
                }

                try {
                    str = "{" + data.toString().replace(/^event: message\s*data/, '"event": "message", "data"') + "}";
                    msg = JSON.parse(str);
                    //debug(msg);
                }
                catch(e) {
                    debug(str);
                    return;
                }

                data = msg.data;
                debug('DATA', data)

                switch (data.resource) {
                    case Constants.RESOURCE_CAMERAS:
                        for (let i = 0; i < msg.data.properties.length; i++) {
                            let info = msg.data.properties[i];
                            let camera = this.devices[info.serialNumber];

                            if (camera === undefined) {
                                continue;
                            }

                            camera.emit(Constants.EVENT_UPDATE, info);
                        }

                        break;
                    case Constants.RESOURCE_MODES:
                        let baseStation = this.devices[msg.data.from];

                        if (baseStation) {
                            baseStation.emit(msg.data.properties.active);
                        }

                        break;
                    case Constants.RESOURCE_MEDIAUPLOAD:
                        this.emit(Constants.RESOURCE_MEDIAUPLOAD, data)
                        break;
                    default:
                        if (reSubscription.test(msg.data.resource)) {
                            let device = this.devices[msg.data.from];
                            
                            if (device !== undefined) {
                                device.isSubscribed = true;
                            }
                        }
                        else if (reCamera.test(msg.data.resource)) {
                            let deviceId;

                            [, deviceId] = msg.data.resource.match(reCamera);

                            let camera = this.devices[deviceId];

                            if (!camera || msg.data.properties === undefined) {
                                return;
                            }

                            switch(data.action) {
                                case Constants.FF_SNAPSHOT_AVAILABLE:
                                    camera.emit(Constants.FF_SNAPSHOT_AVAILABLE, data.properties.presignedFullFrameSnapshotUrl);
                                    break;
                                case "is":
                                    if (data.properties.activityState === Constants.FF_SNAPSHOT) {
                                        let callback = this.pendingSnapshots[data.transId];
                                        delete this.pendingSnapshots[data.transId];

                                        if (typeof(callback) == 'function') {
                                            callback(data.error, data);
                                        }

                                        return;
                                    }

                                    if (data.properties[Constants.EVENT_MOTION] !== undefined) {
                                        camera.emit(Constants.EVENT_MOTION, data.properties[Constants.EVENT_MOTION]);
                                    }

                                    if (data.properties[Constants.EVENT_AUDIO] !== undefined) {
                                        camera.emit(Constants.EVENT_AUDIO, data.properties[Constants.EVENT_AUDIO]);
                                    }

                                    if (data.properties[Constants.EVENT_BATTERY] !== undefined) {
                                        camera.emit(Constants.EVENT_BATTERY, data.properties[Constants.EVENT_BATTERY]);
                                    }

                                    if (data.properties[Constants.EVENT_CHARGING] !== undefined) {
                                        camera.emit(Constants.EVENT_CHARGING, data.properties[Constants.EVENT_CHARGING]);
                                    }

                                    camera.emit(Constants.EVENT_UPDATE, data.properties);
                            }
                        }
                }
            }.bind(this))
            .on('error', (err) => {
                debug(err)
            })
    }

    downloadSnapshot(url, callback) {
        var bufs = [];

        Request
            .get(url)
            .on('data', function(data) {
                bufs.push(data);
            })
            .on('end', function() {
                if (typeof(callback) == 'function') {
                    callback(Buffer.concat(bufs));
                }
            });
    }
    
    getSnapshot(device, callback, label) {
        if (!label) {
            label = 'node-arlo';
        }

        let parent = this.devices[device.parentId];
        let transId = label + '-' + device.deviceId + '!snapshot-' + Date.now();

        let body = {
            [Constants.FROM]       : this.userId + "_web",
            [Constants.TO]         : parent.id,
            [Constants.ACTION]     : Constants.ACTION_SET,
            [Constants.RESOURCE]   : Constants.RESOURCE_CAMERAS + "/" + device.deviceId,
            [Constants.PUBLISH]    : true,
            [Constants.TRANS_ID]   : transId,
            [Constants.PROPERTIES] : {[Constants.ACTIVITY_STATE]: Constants.FF_SNAPSHOT}
        }

        this._post(
            Constants.WEB.SNAPSHOT,
            body,
            {[Constants.XCLOUD_ID]: parent.cloudId},
            function(error, response, data) {
                if (data && data.success === true) {
                    this.pendingSnapshots[transId] = callback;
                }
                else if (typeof(callback) == 'function') {
                    callback(null);
                }
            }.bind(this)
        );
    }

    getStream(device, callback, label) {
        if (!label) {
            label = 'node-arlo';
        }

        debug('Device: %O', device);

        let deviceId = device.deviceId;
        let parentId = device.parentId;
        let cloudId = device.xCloudId;

        let transId = label + '-' + deviceId + '!stream-' + Date.now();
        let body = {
            [Constants.FROM]       : this.userId + "_web",
            [Constants.TO]         : parentId,
            [Constants.ACTION]     : Constants.ACTION_SET,
            [Constants.RESOURCE]   : Constants.RESOURCE_CAMERAS + "/" + deviceId,
            [Constants.PUBLISH]    : true,
            [Constants.TRANS_ID]   : transId,
            [Constants.PROPERTIES] : {[Constants.ACTIVITY_STATE]: "startUserStream", [Constants.CAMERA_ID]: deviceId}
        };

        debug('Getting stream');
        this._post(Constants.WEB.STREAM, body, {[Constants.XCLOUD_ID]: cloudId}, function(error, response, body) {
            if (error || body.data.url === null || body.data.url === undefined) {
                debug('Error getting stream: %O', error);
                return;
            }

            if (typeof(callback) == 'function') {
                let url = body.data.url.replace('rtsp://','rtsps://');
                debug('Got stream URL: %s', url);
                callback(url);
                callback = undefined;
            }
        });
    }

    notify(device, body, callback) {
        try {
            if (typeof device === 'string') {
                device = this.devices[device];
            }

            body[Constants.FROM] = this.userId + "_web";
            body[Constants.TO]   = device.id;

            this._post(Constants.WEB.NOTIFY + device.id, body, {[Constants.XCLOUD_ID]: device.cloudId}, callback);
        }
        catch(e) {
            console.log(e);
            console.log(device);
        }
    }

    _get(url, headers, callback) {
        Request(
            {url: url, method: HTTP_GET, json: true, jar: true, headers: Extend(headers || {}, this.headers)},
            function (error, response, body) {
                debugComm(body);

                if (typeof(callback) == 'function') {
                    callback(error, response, body);
                }
            }
        );
    }

    _post(url, body, headers, callback) {
        debugComm({url: url, method: HTTP_POST, body: body, json:true, jar: true, headers: Extend(headers || {}, this.headers)});
        Request(
            {url: url, method: HTTP_POST, body: body, json:true, jar: true, headers: Extend(headers || {}, this.headers)},
            function (error, response, body) {
                debugComm(body);

                if (typeof(callback) == 'function') {
                    callback(error, response, body);
                }
            }
        );
    }
}

Arlo.ARMED    = Constants.MODE_ARMED;
Arlo.DISARMED = Constants.MODE_DISARMED;

Arlo.BASESTATION = Constants.TYPE_BASESTATION;
Arlo.CAMERA      = Constants.TYPE_CAMERA;
Arlo.Q           = Constants.TYPE_ARLOQS;
Arlo.SIREN       = Constants.TYPE_SIREN;

Arlo.AUDIO    = Constants.EVENT_AUDIO;
Arlo.BATTERY  = Constants.EVENT_BATTERY;
Arlo.CHARGING = Constants.EVENT_CHARGING;
Arlo.FOUND    = Constants.EVENT_FOUND;
Arlo.MOTION   = Constants.EVENT_MOTION;
Arlo.UPDATE   = Constants.EVENT_UPDATE;

Arlo.FF_SNAPSHOT = Constants.FF_SNAPSHOT_AVAILABLE;

module.exports = Arlo;
