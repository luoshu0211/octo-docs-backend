-- Escaped srcdoc may exceed MEDIUMTEXT even for a valid 8 MiB deck.
SET @ppt_html_upgrade = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ppt_version' AND COLUMN_NAME = 'html' AND DATA_TYPE <> 'longtext'),
  'ALTER TABLE ppt_version MODIFY COLUMN html LONGTEXT NOT NULL', 'SELECT 1');
PREPARE ppt_html_stmt FROM @ppt_html_upgrade;
EXECUTE ppt_html_stmt;
DEALLOCATE PREPARE ppt_html_stmt;
