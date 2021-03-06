let EventEmitter = require('events');
let plist = require('plist');
let extend = require('extend');
let fs = require('fs');
const path = require('path');

let exec = require('./exec');

let _checkSerial = (serial) => {
    return /^[a-z0-9]{40,40}$/.test(serial)
        || /^[A-Z0-9]{8}-[A-Z0-9]{16}$/.test(serial); // fix for iphone xs xr xmax
};

class iDeviceClient extends EventEmitter {
    constructor() {
        super();
    }

    listDevices() {
        return exec('idevice_id', ['-l']).then((stdout) => {
            let devices = stdout.split('\n');
            let result = [];
            for (let device of devices) {
                device = device.trim();
                if (_checkSerial(device)) {
                    result.push(device);
                }
            }
            return result;
        });
    }

    // ## raw api ##

    getProperties(serial, option) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        const args = ['-u', serial, '-x']
        if (option) {
            if (('simple' in option) && (option['simple'])) {
                args.push('-s');
            }
            if (('domain' in option) && (option['domain'])) {
                args.push('-q', option['domain']);
            }
        }
        return exec('ideviceinfo', args).then((stdout) => {
            try {
                let result = plist.parse(stdout);
                return result;
            } catch (e) {
                throw e;
            }
        });
    }

    getPackages(serial, option) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        let defaultOption = {
            'list': 'user'
        };
        defaultOption = extend(true, defaultOption, option);
        const args = ['-u', serial, '-l', '-o', 'xml']
        if (defaultOption['list'] === 'system') {
            args.push('-o', 'list_system');
        }
        if (defaultOption['list'] === 'all') {
            args.push('-o', 'list_all');
        }

        return exec('ideviceinstaller', args).then((stdout) => {
            try {
                let result = [];
                let packages = plist.parse(stdout);
                for (let packageObj of packages) {
                    result.push(packageObj['CFBundleIdentifier']);
                }
                return result;
            } catch (e) {
                throw e;
            }
        });
    }

    diagnostics(serial, option) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        let defaultOption = {
            'command': 'diagnostics',
            'key': 'All',
        };
        defaultOption = extend(true, defaultOption, option);
        const args = ['-u', serial, defaultOption['command']]
        if (('key' in defaultOption) && (defaultOption['key'])) {
            args.push(defaultOption['key']);
        }
        return exec('idevicediagnostics', args).then((stdout) => {
            try {
                let result = plist.parse(stdout);
                return result;
            } catch (e) {
                throw e;
            }
        });
    }

    screencap(serial, option) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        let defaultOption = {
            format: 'png'
        }
        defaultOption = extend(true, defaultOption, option);
        let sharp = require('sharp');
        let tempfile = require('tempfile');
        let tempTiffFile = tempfile('.tiff');
        return new Promise((resolve, reject) => {
            exec('idevicescreenshot', ['-u', serial, tempTiffFile]).then((stdout) => {
                let outputStream = sharp(tempTiffFile).toFormat(defaultOption.format).on('error', (err) => {
                    reject(err);
                });
                resolve(outputStream);
            }, reject);
        });
    }

    install(serial, ipa, option) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        if (!fs.existsSync(ipa)) return Promise.reject(`ipa file ${ipa} not exists`);
        let defaultOption = {
            resign: false,
            mobileprovision: './develop.mobileprovision',
            identity: 'iPhone Developer: xxxx (XXXXXXXXXX)',
            keychainPassword: ''
        };
        defaultOption = extend(true, defaultOption, option);
        let resultPromise;
        if (defaultOption.resign) {
            let path = require('path');
            let shell = path.join(__dirname, 'tools', 'r.sh');
            resultPromise = exec(['sh', shell, ipa, defaultOption.mobileprovision,
                                    defaultOption.identity, ipa, defaultOption.keychainPassword], {timeout: 300000});
        } else {
            resultPromise = Promise.resolve();
        }
        return resultPromise.then(() => {
            return new Promise((resolve, reject) => {
                exec('ideviceinstaller', ['-u', serial, '-i', ipa], {timeout: 300000}).then((output) => {
                    if (/\s - Complete\s/.test(output)) {
                        resolve(output);
                    } else {
                        reject(output);
                    }
                }, (code, stdout, stderr) => {
                    reject(code);
                });
            })
        });
    }

    syslog(serial, ipa) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        let patternFile = require('path').join(__dirname, 'patterns.yml');
        let spawn = require('child_process').spawn;
        let emitter = new EventEmitter();
        let process = spawn('idevicesyslog', ['-u', serial]);
        let Logparser = require('logagent-js');
        let lp = new Logparser(patternFile);
        process.stdout.setEncoding('utf8');
        process.stdout.on('data', (data) => {
            let str = data.toString(),
                lines = str.split(/(\r?\n)/g);
            for (let line of lines) {
                lp.parseLine(line, 'log', (err, data) => {
                    if (err) {
                    } else {
                        emitter.emit('log', data);
                    }
                });
            }
        });
        process.stdout.on('end', () => {
            emitter.emit('close');
        });
        emitter.on('close', () => {
            process.kill();
        });
        return Promise.resolve(emitter);
    }

    reboot(serial) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        return exec('idevicediagnostics', ['restart', '-u', serial]).then(() => {
            return true;
        });
    }

    shutdown(serial) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        return exec('idevicediagnostics', ['shutdown', '-u', serial]).then(() => {
            return true;
        });
    }

    activate(serial) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        return exec('ideviceactivation', ['activate', '-u', serial]).then(() => {
            return true;
        });
    }

    deactivate(serial) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        return exec('ideviceactivation', ['deactivate', '-u', serial]).then(() => {
            return true;
        });
    }

    name(serial, newName) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        const args = ['-u', serial];

        if(typeof newName !== 'undefined') {
            args.push(newName);
        }
        return exec('idevicename', args).then((result) => {
            return result.trim();
        });
    }

    // ## shortcut method ##

    getBasicInformation(serial) {
        return this.getProperties(serial)
            .then((result) => {
                let type = result['ProductType'];
                let map = require('./map.json');
                if (type in map) {
                    return map[type];
                }
                return {};
            });
    }

    getResolution(serial) {
        return this.getProperties(serial, {domain: 'com.apple.mobile.iTunes'})
            .then((result) => {
                let resolution = {
                    width: parseInt(result['ScreenWidth'], 10),
                    height: parseInt(result['ScreenHeight'], 10),
                    scale: parseInt(result['ScreenScaleFactor'], 10)
                };
                let points = {
                    width: Math.floor(resolution.width / resolution.scale),
                    height: Math.floor(resolution.height / resolution.scale)
                }; 
                if ((resolution.width === 1080) && (resolution.height === 1920)) {
                    // There is some diffences between Physical Pixels and Rendered Pixels
                    // on device iPhone [6,6s,7] plus.
                    points = {
                        width: 414,
                        height: 736
                    };
                }
                resolution.points = points;
                return resolution;
            });
    }

    getStorage(serial) {
        return this.getProperties(serial, {domain: 'com.apple.disk_usage'})
            .then((result) => {
                let size = result['TotalDataCapacity'];
                let free = result['TotalDataAvailable'];
                let used = size - free;
                return {
                    size: size,
                    used: used,
                    free: free,
                    free_percent: parseInt(free * 100 / (size + 2), 10) + '%'
                }
            });
    }

    getBattery(serial) {
        return this.getProperties(serial, {domain: 'com.apple.mobile.battery'})
            .then((result) => {
                result['level'] = result['BatteryCurrentCapacity'];
                return result;
            });
    }

    getDeveloperStatus(serial) {
        return this.getProperties(serial, {domain: 'com.apple.xcode.developerdomain'})
            .then((result) => {
                return result['DeveloperStatus'];
            });
    }

    crashreport(serial, appName) {
        if (!_checkSerial(serial)) return Promise.reject('invalid serial number');
        return exec('mktemp', ['-d']).then((tmpDir) => {
            tmpDir = tmpDir.trim();
            return exec('idevicecrashreport', ['-u', serial, '-e', tmpDir]).then(() => {
                let crashLogRegex = new RegExp(`^${appName}.*\.ips$`); 
                let result = {};
                fs.readdirSync(tmpDir).forEach((currentFile) => {
                    let crashLogFileName = crashLogRegex.exec(currentFile);
                    if (crashLogFileName !== null) {
                        result.currentFile = fs.readFileSync(path.join(tmpDir, currentFile), 'utf8');
                    }
                });
                
                return result; 
            });
        });
    }
}

module.exports = new iDeviceClient();
