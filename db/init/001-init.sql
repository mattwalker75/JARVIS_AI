-- JARVIS memory database bootstrap.
-- The application user (created by the MySQL image from MYSQL_USER/MYSQL_PASSWORD)
-- is granted FULL privileges on the memory database so the LLM can create, alter,
-- insert, update, and delete anything it wants. The LLM owns this database.

CREATE DATABASE IF NOT EXISTS jarvis_memory;

GRANT ALL PRIVILEGES ON jarvis_memory.* TO 'jarvis'@'%';
FLUSH PRIVILEGES;

USE jarvis_memory;

-- A starter table so memory works out of the box. The LLM is free to restructure,
-- add tables, or ignore this entirely.
CREATE TABLE IF NOT EXISTS memories (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    kind VARCHAR(64) NOT NULL DEFAULT 'note',        -- e.g. short_term, long_term, fact, preference
    content TEXT NOT NULL,
    tags VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_kind (kind)
);
