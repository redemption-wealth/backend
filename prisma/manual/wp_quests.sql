--
-- PostgreSQL database dump
--

\restrict Q1Fr3pQxxaPJYjsc7juf8yBBvCTCzfcborLfKFkhakeBed7N61AR5qLhET3HlvK

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id text NOT NULL,
    "privyId" text NOT NULL,
    email text NOT NULL,
    "walletAddress" text,
    "referralCode" text NOT NULL,
    "referredById" text,
    "hasDeposited" boolean DEFAULT false NOT NULL,
    "qualifiedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: checkin_streaks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkin_streaks (
    "appUserId" text NOT NULL,
    "currentStreak" integer DEFAULT 0 NOT NULL,
    "lastCheckinDate" date,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: quest_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quest_completions (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    "questId" text NOT NULL,
    "periodKey" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: quests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quests (
    id text NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    "rewardWp" integer NOT NULL,
    cadence text NOT NULL,
    "targetCount" integer DEFAULT 1 NOT NULL,
    "actionUrl" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: wp_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wp_ledger (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    amount integer NOT NULL,
    type text NOT NULL,
    "refType" text,
    "refId" text,
    note text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: wp_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wp_redemptions (
    id text NOT NULL,
    "appUserId" text NOT NULL,
    "rewardId" text NOT NULL,
    "wpSpent" integer NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    note text,
    "fulfilledBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: wp_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wp_rewards (
    id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    "partnerName" text,
    "wpCost" integer NOT NULL,
    stock integer,
    "isActive" boolean DEFAULT true NOT NULL,
    "imageUrl" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: checkin_streaks checkin_streaks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkin_streaks
    ADD CONSTRAINT checkin_streaks_pkey PRIMARY KEY ("appUserId");


--
-- Name: quest_completions quest_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT quest_completions_pkey PRIMARY KEY (id);


--
-- Name: quests quests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quests
    ADD CONSTRAINT quests_pkey PRIMARY KEY (id);


--
-- Name: wp_ledger wp_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_ledger
    ADD CONSTRAINT wp_ledger_pkey PRIMARY KEY (id);


--
-- Name: wp_redemptions wp_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT wp_redemptions_pkey PRIMARY KEY (id);


--
-- Name: wp_rewards wp_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_rewards
    ADD CONSTRAINT wp_rewards_pkey PRIMARY KEY (id);


--
-- Name: app_users_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_users_email_idx ON public.app_users USING btree (email);


--
-- Name: app_users_privyId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "app_users_privyId_key" ON public.app_users USING btree ("privyId");


--
-- Name: app_users_referralCode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "app_users_referralCode_key" ON public.app_users USING btree ("referralCode");


--
-- Name: app_users_referredById_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "app_users_referredById_idx" ON public.app_users USING btree ("referredById");


--
-- Name: quest_completions_appUserId_questId_periodKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "quest_completions_appUserId_questId_periodKey_key" ON public.quest_completions USING btree ("appUserId", "questId", "periodKey");


--
-- Name: quests_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quests_key_key ON public.quests USING btree (key);


--
-- Name: wp_ledger_appUserId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wp_ledger_appUserId_createdAt_idx" ON public.wp_ledger USING btree ("appUserId", "createdAt");


--
-- Name: wp_ledger_type_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wp_ledger_type_createdAt_idx" ON public.wp_ledger USING btree (type, "createdAt");


--
-- Name: wp_redemptions_appUserId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wp_redemptions_appUserId_idx" ON public.wp_redemptions USING btree ("appUserId");


--
-- Name: wp_redemptions_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wp_redemptions_status_createdAt_idx" ON public.wp_redemptions USING btree (status, "createdAt");


--
-- Name: app_users app_users_referredById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT "app_users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: checkin_streaks checkin_streaks_appUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkin_streaks
    ADD CONSTRAINT "checkin_streaks_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: quest_completions quest_completions_appUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT "quest_completions_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: quest_completions quest_completions_questId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quest_completions
    ADD CONSTRAINT "quest_completions_questId_fkey" FOREIGN KEY ("questId") REFERENCES public.quests(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: wp_ledger wp_ledger_appUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_ledger
    ADD CONSTRAINT "wp_ledger_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: wp_redemptions wp_redemptions_appUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT "wp_redemptions_appUserId_fkey" FOREIGN KEY ("appUserId") REFERENCES public.app_users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: wp_redemptions wp_redemptions_rewardId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wp_redemptions
    ADD CONSTRAINT "wp_redemptions_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES public.wp_rewards(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict Q1Fr3pQxxaPJYjsc7juf8yBBvCTCzfcborLfKFkhakeBed7N61AR5qLhET3HlvK


ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS "wpMonthlyCapWp" integer NOT NULL DEFAULT 1000000;
