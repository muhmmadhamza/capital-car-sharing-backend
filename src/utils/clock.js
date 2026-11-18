const config = require('../config/env');

// Current wall-clock time ("YYYY-MM-DDTHH:mm") in the business time zone: what "in the future" means for a pickup.
// One definition, shared by the reservation service and the request validators.
function nowWall(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.businessTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

module.exports = { nowWall };
