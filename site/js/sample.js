/* Made-up example board, in the same shape the feed returns. Shown until real lines load. */
(function (root) {
  "use strict";
  function at(now, dow, h, m) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    var add = (dow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + add);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 7);
    return d.toISOString();
  }
  function book(key, title, sp, tot, ml, away, home) {
    var markets = [];
    if (sp) markets.push({ key: "spreads", outcomes: [
      { name: away, price: sp[1], point: sp[0] }, { name: home, price: sp[3], point: sp[2] }] });
    if (tot) markets.push({ key: "totals", outcomes: [
      { name: "Over", price: tot[1], point: tot[0] }, { name: "Under", price: tot[3], point: tot[2] }] });
    if (ml) markets.push({ key: "h2h", outcomes: [
      { name: away, price: ml[0] }, { name: home, price: ml[1] }] });
    return { key: key, title: title, markets: markets };
  }
  function ev(id, when, rot, away, home, fd, dk) {
    var bms = [];
    if (fd) bms.push(book("fanduel", "FanDuel", fd[0], fd[1], fd[2], away, home));
    if (dk) bms.push(book("draftkings", "DraftKings", dk[0], dk[1], dk[2], away, home));
    return { id: id, sport_key: "americanfootball_ncaaf", commence_time: when, away_team: away, home_team: home,
      away_rotation: rot, home_rotation: rot + 1, bookmakers: bms };
  }
  function sampleEvents(now) {
    return [
      ev("s1", at(now, 2, 18, 30), 105, "Liberty Flames", "Kennesaw State Owls",
        [[-7.5, -110, 7.5, -110], [49.5, -110, 49.5, -110], [-290, 235]],
        [[-7.5, -110, 7.5, -110], [49.5, -110, 49.5, -110], [-290, 235]]),
      ev("s2", at(now, 3, 19, 0), 109, "Sam Houston Bearkats", "UTEP Miners",
        [[3.5, -110, -3.5, -110], [44.5, -110, 44.5, -110], [140, -166]],
        null),
      ev("s3", at(now, 4, 21, 0), 113, "Kansas State Wildcats", "Arizona Wildcats",
        [[2.5, -110, -2.5, -110], [54.5, -110, 54.5, -110], [118, -140]],
        [[3, -115, -3, -105], [54.5, -108, 54.5, -112], [120, -142]]),
      ev("s4", at(now, 6, 11, 0), 151, "Penn State Nittany Lions", "Iowa Hawkeyes",
        [[-4.5, -110, 4.5, -110], [45.5, -110, 45.5, -110], [-192, 160]],
        [[-4.5, -112, 4.5, -108], [46.5, -110, 46.5, -110], [-185, 154]]),
      ev("s5", at(now, 6, 14, 30), 167, "Ole Miss Rebels", "LSU Tigers",
        [[3.5, -110, -3.5, -110], [56.5, -110, 56.5, -110], [150, -175]],
        [[3.5, -105, -3.5, -115], [56.5, -110, 56.5, -110], [140, -160]]),
      ev("s6", at(now, 6, 18, 30), 183, "USC Trojans", "Michigan Wolverines",
        [[6.5, -108, -6.5, -112], [48.5, -110, 48.5, -110], [205, -250]],
        [[6.5, -115, -6.5, -105], [48.5, -105, 48.5, -115], [200, -245]]),
      ev("s7", at(now, 6, 21, 30), 197, "Utah Utes", "BYU Cougars",
        [[-1.5, -110, 1.5, -110], [50.5, -110, 50.5, -110], [-125, 105]],
        [[-1, -110, 1, -110], [50.5, -110, 50.5, -110], [-120, 100]])
    ];
  }
  if (typeof module !== "undefined" && module.exports) module.exports = sampleEvents;
  else root.LS_SAMPLE = sampleEvents;
})(this);
