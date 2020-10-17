# JME HealthMonitor

A simple health monitor for jme services.

## Build
```console
docker build -t jme-healthmonitor .
```


## Run
```console
docker run \
-d \
--restart=always \
--name="jme-healthmonitor" \
--read-only \
-v $PWD/config.json:/app/config.json:ro \
-p 8080:8080 \
--tmpfs /tmp \
 jme-healthmonitor
```