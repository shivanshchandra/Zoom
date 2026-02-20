export const generateMeetingId = (length = 10) => {
  // Example output: "k9x3p8q1z2"
  return Math.random().toString(36).slice(2, 2 + length);
};