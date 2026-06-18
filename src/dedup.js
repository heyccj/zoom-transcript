export function makeKey(time, name, msg) {
  return (time || '') + '|' + (name || '') + '|' + msg.slice(0, 40);
}

export function isProgressiveUpdate(prev, time, name, msg) {
  if (prev.time !== time || prev.name !== name) return false;
  return msg.indexOf(prev.msg) === 0 || prev.msg.indexOf(msg) === 0;
}

export function dedupLog(entries) {
  let result = [];
  entries.forEach(function (e) {
    let matchIdx = -1;
    for (let j = result.length - 1; j >= 0; j--) {
      let prev = result[j];
      if (prev.time !== e.time || prev.name !== e.name) continue;
      if (isProgressiveUpdate(prev, e.time, e.name, e.msg)) {
        matchIdx = j;
        break;
      }
    }
    if (matchIdx >= 0) {
      if (e.msg.length >= result[matchIdx].msg.length) {
        result[matchIdx].msg = e.msg;
      }
    } else {
      result.push({
        key: e.key,
        time: e.time,
        name: e.name,
        msg: e.msg,
        src: e.src,
        marker: e.marker,
        chat: e.chat
      });
    }
  });
  result.forEach(function (e) {
    e.key = makeKey(e.time, e.name, e.msg);
  });
  let keySeen = new Set();
  return result.filter(function (e) {
    if (keySeen.has(e.key)) return false;
    keySeen.add(e.key);
    return true;
  });
}
