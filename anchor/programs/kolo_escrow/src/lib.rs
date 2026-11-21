use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"); // PLACEHOLDER — replace after `anchor build` (see README)

/// Fee taken on release, in basis points (150 = 1.5%).
pub const FEE_BPS: u64 = 150;

#[program]
pub mod kolo_escrow {
    use super::*;

    /// Depositor locks `amount` of SPL tokens in a non-custodial PDA vault.
    /// The depositor is also the release authority (buyer for commerce orders,
    /// seller for P2P trades). No admin keys — the platform cannot move funds.
    pub fn init_escrow(ctx: Context<InitEscrow>, amount: u64, seed: u64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);

        let esc = &mut ctx.accounts.escrow;
        esc.depositor = ctx.accounts.depositor.key();
        esc.mint = ctx.accounts.mint.key();
        esc.seed = seed;
        esc.amount = amount;
        esc.vault_bump = ctx.bumps.vault;
        esc.bump = ctx.bumps.escrow;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.depositor_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Release authority (the depositor) signs: net amount goes to
    /// `recipient_ata`, the 1.5% fee goes to `fee_ata`, vault is closed.
    pub fn release(_ctx: Context<Release>, _seed: u64) -> Result<()> {
        let ctx = _ctx;
        let esc = &ctx.accounts.escrow;

        let fee = esc
            .amount
            .checked_mul(FEE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(EscrowError::Overflow)?;
        let net = esc.amount.checked_sub(fee).ok_or(EscrowError::Overflow)?;

        let signer_seeds: &[&[&[u8]]] = &[&[b"escrow".as_ref(), &esc.seed.to_le_bytes(), &[esc.bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            net,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.releaser.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))?;

        Ok(())
    }

    /// Depositor cancels: full amount returns to their ATA, vault is closed.
    pub fn cancel(_ctx: Context<Cancel>, _seed: u64) -> Result<()> {
        let ctx = _ctx;
        let esc = &ctx.accounts.escrow;
        let signer_seeds: &[&[&[u8]]] = &[&[b"escrow".as_ref(), &esc.seed.to_le_bytes(), &[esc.bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            esc.amount,
        )?;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))?;

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct EscrowInfo {
    pub depositor: Pubkey, // also the release authority
    pub mint: Pubkey,
    pub seed: u64,
    pub amount: u64,
    pub vault_bump: u8,
    pub bump: u8,
}

#[error_code]
pub enum EscrowError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("caller is not the escrow authority")]
    NotAuthority,
    #[msg("token mint mismatch")]
    MintMismatch,
    #[msg("seed does not match this escrow")]
    SeedMismatch,
    #[msg("arithmetic overflow")]
    Overflow,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitEscrow<'info> {
    #[account(
        init,
        payer = depositor,
        space = 8 + EscrowInfo::INIT_SPACE,
        seeds = [b"escrow".as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowInfo>,

    #[account(
        init,
        payer = depositor,
        token::mint = mint,
        token::authority = escrow,
        seeds = [b"vault".as_ref(), escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        constraint = depositor_ata.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = depositor_ata.owner == depositor.key() @ EscrowError::NotAuthority,
    )]
    pub depositor_ata: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Release<'info> {
    #[account(
        mut,
        seeds = [b"escrow".as_ref(), &seed.to_le_bytes()],
        bump,
        constraint = escrow.seed == seed @ EscrowError::SeedMismatch,
        constraint = escrow.depositor == releaser.key() @ EscrowError::NotAuthority,
        close = releaser
    )]
    pub escrow: Account<'info, EscrowInfo>,

    #[account(
        mut,
        seeds = [b"vault".as_ref(), escrow.key().as_ref()],
        bump = escrow.vault_bump,
        constraint = vault.mint == escrow.mint @ EscrowError::MintMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = recipient_ata.mint == escrow.mint @ EscrowError::MintMismatch)]
    pub recipient_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = fee_ata.mint == escrow.mint @ EscrowError::MintMismatch)]
    pub fee_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub releaser: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Cancel<'info> {
    #[account(
        mut,
        seeds = [b"escrow".as_ref(), &seed.to_le_bytes()],
        bump,
        constraint = escrow.seed == seed @ EscrowError::SeedMismatch,
        constraint = escrow.depositor == owner.key() @ EscrowError::NotAuthority,
        close = owner
    )]
    pub escrow: Account<'info, EscrowInfo>,

    #[account(
        mut,
        seeds = [b"vault".as_ref(), escrow.key().as_ref()],
        bump = escrow.vault_bump,
        constraint = vault.mint == escrow.mint @ EscrowError::MintMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = owner_ata.mint == escrow.mint @ EscrowError::MintMismatch)]
    pub owner_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
