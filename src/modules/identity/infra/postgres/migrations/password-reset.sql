-- Password reset: challenges may now prove mailbox ownership for a reset.
ALTER TABLE public.n2f_identity_verification_challenges
    DROP CONSTRAINT n2f_identity_verification_challenges_purpose_check;
ALTER TABLE public.n2f_identity_verification_challenges
    ADD CONSTRAINT n2f_identity_verification_challenges_purpose_check
    CHECK ((purpose = ANY (ARRAY['email_verification'::text, 'password_reset'::text])));
