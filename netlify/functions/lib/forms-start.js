// forms-start.js -- 2026-10-19
//
// How many forms are on a roll right after a restock. A full roll is 800. Florida and North
// Carolina techs peel about 100 forms off the roll of a surfboard (SB: one printer) so it does not
// rub the back of the cabinet, which leaves 700. Kahunas (SK) and Big Kahunas (BK) take the full 800.
// Keep this in step with public.forms_start_count() in the database (usage rates and estimates use it).
function formsStartCount(state, machineType) {
  const st = String(state || '').toUpperCase();
  const mt = String(machineType || '').toUpperCase();
  if ((st === 'FL' || st === 'NC') && mt === 'SB') return 700;
  return 800;
}
// FL/NC counts only mean something once the machine type is known (it sets the start count).
function startCountKnown(state, machineType) {
  const st = String(state || '').toUpperCase();
  if (st !== 'FL' && st !== 'NC') return true;
  return ['SB', 'SK', 'BK'].includes(String(machineType || '').toUpperCase());
}
module.exports = { formsStartCount, startCountKnown };
