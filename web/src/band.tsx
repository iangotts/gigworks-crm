import { createContext, useContext } from 'react';

export interface Band {
  name: string;
  slug: string;
}

/** The band being worked in. Templates fill {band} from the name, links use the slug as their source. */
export const BandContext = createContext<Band>({ name: '', slug: '' });
export const useBand = (): Band => useContext(BandContext);
export const useBandName = (): string => useContext(BandContext).name;
