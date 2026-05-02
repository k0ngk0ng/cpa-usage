package sqlite

import (
	"context"
	"time"

	"gorm.io/gorm"

	"github.com/k0ngk0ng/cpa-usage/internal/storage"
)

// ReplaceAuthFiles atomically swaps the cached auth files snapshot.
func (s *Store) ReplaceAuthFiles(ctx context.Context, files []storage.AuthFile) error {
	now := time.Now().UTC()
	return s.dbCtx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&authFileModel{}).Error; err != nil {
			return err
		}
		if len(files) == 0 {
			return nil
		}
		rows := make([]authFileModel, 0, len(files))
		for _, f := range files {
			if f.AuthIndex == "" {
				continue
			}
			rows = append(rows, authFileModel{
				AuthIndex:   f.AuthIndex,
				Name:        f.Name,
				Email:       f.Email,
				Type:        f.Type,
				Provider:    f.Provider,
				Label:       f.Label,
				Status:      f.Status,
				Source:      f.Source,
				Disabled:    f.Disabled,
				Unavailable: f.Unavailable,
				RuntimeOnly: f.RuntimeOnly,
				UpdatedAt:   now,
			})
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.CreateInBatches(&rows, 200).Error
	})
}

// ListAuthFiles returns the cached auth-files entries.
func (s *Store) ListAuthFiles(ctx context.Context) ([]storage.AuthFile, error) {
	var rows []authFileModel
	if err := s.dbCtx(ctx).Order("auth_index").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]storage.AuthFile, 0, len(rows))
	for _, r := range rows {
		out = append(out, storage.AuthFile{
			AuthIndex:   r.AuthIndex,
			Name:        r.Name,
			Email:       r.Email,
			Type:        r.Type,
			Provider:    r.Provider,
			Label:       r.Label,
			Status:      r.Status,
			Source:      r.Source,
			Disabled:    r.Disabled,
			Unavailable: r.Unavailable,
			RuntimeOnly: r.RuntimeOnly,
		})
	}
	return out, nil
}

// ReplaceProviderMetadata atomically swaps the cached provider catalog snapshot.
func (s *Store) ReplaceProviderMetadata(ctx context.Context, items []storage.ProviderMetadata) error {
	now := time.Now().UTC()
	return s.dbCtx(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&providerMetadataModel{}).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		rows := make([]providerMetadataModel, 0, len(items))
		for _, m := range items {
			if m.LookupKey == "" {
				continue
			}
			rows = append(rows, providerMetadataModel{
				LookupKey:    m.LookupKey,
				ProviderType: m.ProviderType,
				DisplayName:  m.DisplayName,
				ProviderKey:  m.ProviderKey,
				MatchKind:    m.MatchKind,
				UpdatedAt:    now,
			})
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.CreateInBatches(&rows, 200).Error
	})
}

// ListProviderMetadata returns all cached provider metadata entries.
func (s *Store) ListProviderMetadata(ctx context.Context) ([]storage.ProviderMetadata, error) {
	var rows []providerMetadataModel
	if err := s.dbCtx(ctx).Order("provider_type, lookup_key").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]storage.ProviderMetadata, 0, len(rows))
	for _, r := range rows {
		out = append(out, storage.ProviderMetadata{
			LookupKey:    r.LookupKey,
			ProviderType: r.ProviderType,
			DisplayName:  r.DisplayName,
			ProviderKey:  r.ProviderKey,
			MatchKind:    r.MatchKind,
		})
	}
	return out, nil
}
