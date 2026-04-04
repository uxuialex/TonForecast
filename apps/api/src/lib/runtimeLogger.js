function write(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: "api",
    event,
    ...fields,
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function logInfo(event, fields = {}) {
  write("info", event, fields);
}

export function logWarn(event, fields = {}) {
  write("warn", event, fields);
}

export function logError(event, fields = {}) {
  write("error", event, fields);
}
