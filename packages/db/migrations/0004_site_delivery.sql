-- Where a site's lead cards go. NULL means "log only" until the customer sets it.
ALTER TABLE sites ADD COLUMN lead_email TEXT;
