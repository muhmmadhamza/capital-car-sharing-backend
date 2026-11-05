
const bcrypt = require("bcrypt");

const hash =
  "$2a$10$YGdgL2tFAKPtGvWWgnSX9e0PYoOMm1LBiWKEO52Wbc6PbulldpZtu";

// Yahan woh password likhein jo aap check karna chahte hain
const password = "your_candidate_password";

bcrypt.compare(password, hash, (err, result) => {
  if (err) {
    console.error("Error:", err);
    return;
  }

  console.log(
    result ? "Password Matched!" : "Password Incorrect!"
  );
});