WITH `recipe_provenance` AS (
  SELECT
    `recipes`.`id` AS `recipe_id`,
    COALESCE(
      (
        SELECT `import_sessions`.`requested_by`
        FROM `import_sessions`
        WHERE `import_sessions`.`resulting_recipe_id` = `recipes`.`id`
          AND `import_sessions`.`requested_by` IS NOT NULL
        ORDER BY `import_sessions`.`created_at` ASC
        LIMIT 1
      ),
      (
        SELECT `app_users`.`user_id`
        FROM `app_users`
        WHERE `app_users`.`role` = 'owner'
        ORDER BY `app_users`.`created_at` ASC
        LIMIT 1
      )
    ) AS `created_by_user_id`
  FROM `recipes`
)
UPDATE `recipes`
SET `aggregate` = json_set(
  `aggregate`,
  '$.createdByUserId',
  (
    SELECT `recipe_provenance`.`created_by_user_id`
    FROM `recipe_provenance`
    WHERE `recipe_provenance`.`recipe_id` = `recipes`.`id`
  )
)
WHERE json_extract(`aggregate`, '$.createdByUserId') IS NULL
  AND (
    SELECT `recipe_provenance`.`created_by_user_id`
    FROM `recipe_provenance`
    WHERE `recipe_provenance`.`recipe_id` = `recipes`.`id`
  ) IS NOT NULL;
