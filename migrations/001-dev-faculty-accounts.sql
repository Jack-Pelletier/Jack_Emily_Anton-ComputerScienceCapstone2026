-- Development only: manually enter email addresses for faculty login in SET @dev_name_email. Run DBCreation.sql first. Safe to rerun. 
USE CapstoneDB;

SET @dev_emily_email = 'dalbae@merrimack.edu';
SET @dev_jack_email = 'pelletierje@merrimack.edu';
SET @dev_anton_email = '';

INSERT INTO FacultyAccount (Email)
SELECT DISTINCT LOWER(TRIM(team.Email)) AS Email
FROM (
  SELECT @dev_emily_email AS Email
  UNION ALL SELECT @dev_jack_email
  UNION ALL SELECT @dev_anton_email
) AS team
LEFT JOIN FacultyAccount AS existing
  ON CAST(LOWER(TRIM(existing.Email)) AS BINARY) = CAST(LOWER(TRIM(team.Email)) AS BINARY)
WHERE NULLIF(TRIM(team.Email), '') IS NOT NULL
  AND existing.AccountID IS NULL
ORDER BY Email;
