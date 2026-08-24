const { purgeExpiredRecords } = require('./trashService');

function startTrashScheduler() {
  purgeExpiredRecords().catch(() => {});

  setInterval(() => {
    purgeExpiredRecords().catch(() => {});
  }, 24 * 60 * 60 * 1000);
}

module.exports = { startTrashScheduler };
