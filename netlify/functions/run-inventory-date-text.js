/**
 * run-inventory-date-text.js
 * SAVE AS: netlify/functions/run-inventory-date-text.js
 *
 * Schedule-only wrapper. Netlify blocks a public call to a function that
 * also has a schedule, which hid the board button. This file is the one
 * on the 10-minute schedule. It does nothing until auto is on.
 */
const { handler } = require("./preview-inventory-date-text");

exports.handler = async () => handler({});
