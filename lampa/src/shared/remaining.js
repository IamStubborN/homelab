// Time left as short Russian copy: "осталось 1 ч 5 мин".
function remaining(position, duration) {
  var rest = Math.max(0, duration - position), minutes = Math.round(rest / 60);
  if (rest < 60) return 'осталось меньше минуты';
  if (minutes < 60) return 'осталось ' + minutes + ' мин';
  return 'осталось ' + Math.floor(minutes / 60) + ' ч' + (minutes % 60 ? ' ' + minutes % 60 + ' мин' : '');
}
