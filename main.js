const fetch = require('node-fetch');
const NodeMailer = require('nodemailer');
const Http = require('http');
const Config=require("./config.json");


const smtpSend = (subject, body) => {
    const transport = NodeMailer.createTransport({
        host: Config.smtpHost,
        port: Config.smtpPort,
        auth: {
            user: Config.smtpUser,
            pass: Config.smtpPassword
        }
    });
    transport.sendMail({
        from: Config.smtpSender,
        to: Config.monitorEmail,
        subject: subject,
        text: body
    }, (err, info) => {
        if (err) {
            console.error(err)
        } else {
            console.log(info);
        }
    });
}

const Notifications = {
    DISK_WARN: (usage, guardValue,disk) => `WARN: Disk usage for ${disk} is at ${usage}%. Above the guard value of ${guardValue}%`,
    DISK_FINE: (usage, guardValue,disk) => `FINE: Disk usage for ${disk} is at ${usage}%. Below the guard value of ${guardValue}%`,
    MEMORY_WARN: (available, guardValue) => `WARN: Available memory is ${available}MB. Below the guard value of ${guardValue}MB`,
    MEMORY_FINE: (available, guardValue) => `FINE: Available memory is ${available}MB. Above the guard value of ${guardValue}MB`,
    CONTAINERS_WARN: (containers) => `WARN: Detected unhealthy containers ${containers}`,
    CONTAINERS_FINE: (x) => `FINE: All containers are healthy`,
    HEALTHMONITOR_WARN: (e) => `WARN: Health monitor is down :() ${e}`,
    HEALTHMONITOR_FINE: (e) => `FINE: Health monitor is fine `,
    states: {},
    send: function (k, a,id) {
        const tt = k.split("_");
        const stateName = tt[0]+(id?"-"+id:"");
        const stateValue = tt[1];
        const isNegative = (value) => value != "FINE";
        let currentState = this.states[stateName];
        if (!currentState) currentState = this.states[stateName] = { lastValue: stateValue, count: isNegative(stateValue) ? 1 : 0 }; // initialize

        if (stateValue == currentState.lastValue) currentState.count++;
        else {
            currentState.lastValue = stateValue;
            currentState.count = 1;
        }

        const send = () => {
            const text = this[k](...a);
            const subject = "MONITOR | " + stateValue;
            smtpSend(subject, text);
            console.log(subject, ": ", text);
        }
        if (currentState.count == 1 && !isNegative(stateValue)) {
            send();
        } else if (currentState.count == 2 && isNegative(stateValue)) { // negative states need to happen at least twice.
            send();
        }
    }

}


function _u(u) {
    return u + "?rand=" + Math.random() + "-" + Date.now();
}

async function _get(resource, private) {
    if (!resource.endsWith(".txt")) resource = resource + ".txt";
    const url = _u((private ? Config.privateData : Config.publicData) + "/" + resource);
    const headers = {
        "Pragma": "no-cache",
        "Cache-Control": 'no-cache'
    }
    if (private) headers['Authorization'] = 'Basic ' + Buffer.from(Config.dataUser + ":" + Config.dataPass).toString('base64');
    return fetch(url, { headers: headers }).then(res => res.text());
}

async function getEndPoints(private) {
    return (await _get("index", private)).split("\n").filter(x => x.indexOf(".health") != -1).map(x => x.split(".health")[0]);
}


async function fetchEndPoint(endpoint, private) {
    return _get(endpoint + ".health", private)
}

async function fetchContainers(private) {
    const containers = await (getEndPoints(private).then(x => x.filter(y => y.indexOf(".container") != -1)));
    return containers.map(x => {
        return {
            name: x.split(".container")[0],
            endPoint: x
        };
    });
}

async function diskGuard(disk) {
    const guardValue = 90;
    const healthData = await fetchEndPoint("disks", true);
    const rows = healthData.split("\n");
    let failed = true;
    let usage = "undefined";
    try {
        for (let i in rows) {
            const row = rows[i].trim();
            if (row.endsWith(","+disk)) { // find disk
                const csv = row.split(",");
                usage = csv[csv.length - 2];
                usage = usage.substring(0, usage.length - 1);
                usage = parseInt(usage);
                if (isNaN(usage)) throw "Invalid disk size " + usage;
                failed = usage > guardValue;
                break;
            }
        }
    } catch (e) {
        console.error(e);
        failed = true;
    }
    Notifications.send(failed ? "DISK_WARN" : "DISK_FINE", [usage, guardValue,disk],disk);
}

async function memoryGuard() {
    const guardValue = 512;
    let healthData = -1;
    try {
        healthData = parseInt(await fetchEndPoint("memory-available", true));
        healthData = Math.floor(healthData / 1024 / 1024);
        if (isNaN(healthData)) throw "Invalid memory size " + healthData;
    } catch (e) {
        console.error(e);
        healthData = -1;
    }
    Notifications.send(healthData < guardValue ? "MEMORY_WARN" : "MEMORY_FINE", [healthData, guardValue]);
}


async function containersHealth() {
    const containers = await fetchContainers(true);
    const unhealthyContainers = [];
    try {
        for (let i in containers) {
            const container = containers[i];
            let healthData = await fetchEndPoint(container.endPoint, true);
            healthData = JSON.parse(healthData);
            if (healthData["Status"] != "healthy") unhealthyContainers.push(container.name);
        }
    } catch (e) {
        console.error(e);
        unhealthyContainers.push("...and more...");
    }
    Notifications.send(unhealthyContainers.length != 0 ? "CONTAINERS_WARN" : "CONTAINERS_FINE", [unhealthyContainers.toString()]);
}


async function loop() {
    try {
        await diskGuard("/");
        await diskGuard("/srv");
        await memoryGuard();
        await containersHealth();
        Notifications.send("HEALTHMONITOR_FINE", []);
    } catch (e) {
        console.error(e);
        Notifications.send("HEALTHMONITOR_WARN", [e]);
    }
}



let CONTAINERS_HEALTH = {};
let LAST_PUBLIC_CHECK=0;
async function publicStatusFetcher() {
    const n=Date.now();
    if(n-LAST_PUBLIC_CHECK>60*1000){
        LAST_PUBLIC_CHECK=n;
        console.log("Public Fetch");
    }else{
        return CONTAINERS_HEALTH;
    }
    CONTAINERS_HEALTH={};
    const containers = await fetchContainers(false);
    for (let i in containers) {        
        const container = containers[i];
        CONTAINERS_HEALTH[container.name]={"status":"unhealthy"};
        try {
            let healthData = await fetchEndPoint(container.endPoint, true);
            healthData = JSON.parse(healthData);
            CONTAINERS_HEALTH[container.name]["status"]=healthData["Status"];
        }catch(e){
            console.error(e);
        }
    }
    return CONTAINERS_HEALTH;
}

setInterval(loop, 60*5 *  1000);
loop();

const server = Http.createServer((req, res) => {
    publicStatusFetcher().then(data=>{
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    });
});

server.listen(8080, '0.0.0.0',(err)=>{
    if(err)console.error(err);
    else console.log("Listening...");
})